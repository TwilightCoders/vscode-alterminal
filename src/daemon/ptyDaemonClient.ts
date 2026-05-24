/**
 * PTY Daemon Client — communicates with loomptyd (loompty's reference daemon)
 * over Unix domain sockets.
 *
 * Architecture:
 *   - One persistent control socket for commands (spawn, kill, resize, list,
 *     ping) and asynchronous events (exit, bell).
 *   - Per-session sockets that transition to raw binary mode after attach,
 *     streaming PTY output and accepting stdin writes.
 */

import * as net from "net";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import { Logger } from "../utils/logger";
import {
  type ClientMessage,
  type DaemonMessage,
  type PtyInfo,
  encodeMessage,
  FrameDecoder,
} from "./protocol";

export interface PtyDaemonClientEvents {
  data: (ptyId: string, data: string) => void;
  exit: (ptyId: string, exitCode: number, signal?: number) => void;
  bell: (ptyId: string) => void;
  disconnected: () => void;
}

/**
 * Frame types that answer a request and so participate in id-correlation.
 * Anything else (exit, bell, and unsolicited user_data broadcasts) is an
 * event, never a response — even if it carries an `id`.
 */
const RESPONSE_TYPES = new Set<string>([
  "auth_ok",
  "spawned",
  "ptyList",
  "attached",
  "pong",
  "renamed",
  "error",
]);

/** Env vars to forward to daemon-spawned sessions via command prefix. */
const FORWARD_ENV_KEYS = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "ALTERMINAL_SHELL_INIT",
];

export class PtyDaemonClient extends EventEmitter {
  private _controlSocket: net.Socket | null = null;
  private _controlDecoder = new FrameDecoder();
  private _sessionSockets = new Map<string, net.Socket>();
  private _sessionDecoders = new Map<string, StringDecoder>();
  private _requestId = 0;
  private _pending = new Map<number, { resolve: (msg: DaemonMessage) => void; reject: (err: Error) => void }>();
  private _socketPath = "";
  private _secret: string;
  private _connected = false;

  constructor(sessionId: string, secret: string) {
    super();
    // sessionId is no longer sent to loompty (sessions identified by name/UUID)
    // but we keep the parameter for API compatibility with DaemonManager
    void sessionId;
    this._secret = secret;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the daemon control socket and authenticate. */
  connect(socketPath: string): Promise<void> {
    this._socketPath = socketPath;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;

      socket.on("connect", () => {
        this._controlSocket = socket;
        this._controlDecoder.reset();

        // Authenticate — loompty requires auth as first message
        this._sendControl({ type: "auth", secret: this._secret });

        // Wait for auth_ok
        const onData = (chunk: Buffer) => {
          const messages = this._controlDecoder.decode(chunk);
          for (const msg of messages) {
            const dm = msg as DaemonMessage;
            if (dm.type === "auth_ok") {
              socket.removeListener("data", onData);
              this._connected = true;
              this._wireControlSocket(socket);
              settled = true;
              resolve();
              return;
            }
            if (dm.type === "error") {
              socket.removeListener("data", onData);
              settled = true;
              reject(new Error(`Auth failed: ${(dm as any).message}`));
              socket.destroy();
              return;
            }
          }
        };
        socket.on("data", onData);
      });

      socket.on("close", () => {
        this._connected = false;
        this._controlSocket = null;
        for (const { reject: rej } of this._pending.values()) {
          rej(new Error("Daemon connection closed"));
        }
        this._pending.clear();
        this.emit("disconnected");
      });

      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  /** Gracefully disconnect from the daemon. */
  disconnect(): void {
    // Close all session sockets
    for (const [ptyId, sock] of this._sessionSockets) {
      sock.destroy();
      this._sessionDecoders.delete(ptyId);
    }
    this._sessionSockets.clear();

    // Close control socket
    if (this._controlSocket && !this._controlSocket.destroyed) {
      this._sendControl({ type: "detach" });
      this._controlSocket.end();
    }
    this._connected = false;
    this._controlSocket = null;
  }

  /**
   * Tell the daemon to hand off all sessions to a successor daemon
   * listening at `successorSocketPath`, then shut itself down.
   *
   * Fire-and-forget: on success the daemon transfers sessions (SCM_RIGHTS)
   * and shuts down WITHOUT replying (PROTOCOL §4.11), which closes this
   * connection; on failure it sends an error frame and keeps running. We
   * don't await — the caller polls the canonical control socket to find
   * whichever daemon (successor on success, original on failure) ends up
   * serving it.
   */
  handoff(successorSocketPath: string): void {
    this._sendControl({ type: "handoff", socket: successorSocketPath });
  }

  /**
   * Spawn a new PTY in the daemon and attach for data streaming.
   * Env vars are forwarded via command prefix since loompty sessions
   * inherit the daemon's environment.
   */
  async spawn(
    ptyId: string,
    shell: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): Promise<{ pid: number }> {
    // Build command with env prefix for Alterminal-specific vars
    const envParts: string[] = [];
    for (const key of FORWARD_ENV_KEYS) {
      if (env[key]) {
        envParts.push(`${key}=${shellEscape(env[key])}`);
      }
    }
    const shellCmd = args.length > 0 ? `${shell} ${args.join(" ")}` : shell;
    const command = envParts.length > 0
      ? `env ${envParts.join(" ")} ${shellCmd}`
      : shellCmd;

    const id = this._nextId();
    const response = await this._request({
      type: "spawn",
      id,
      name: ptyId,
      command,
      cwd,
      cols,
      rows,
    });

    if (response.type === "error") {
      throw new Error((response as any).message);
    }
    if (response.type !== "spawned") {
      throw new Error(`Unexpected response: ${response.type}`);
    }

    const pid = (response as any).pid as number;

    // Attach a raw data socket for this session
    await this._attachSession(ptyId);

    return { pid };
  }

  /** Write data to a PTY's stdin via the raw session socket. */
  write(ptyId: string, data: string): void {
    const sock = this._sessionSockets.get(ptyId);
    if (sock && !sock.destroyed) {
      sock.write(data);
    }
  }

  /** Resize a PTY. */
  resize(ptyId: string, cols: number, rows: number): void {
    this._sendControl({ type: "resize", name: ptyId, cols, rows });
  }

  /** Kill a PTY. */
  kill(ptyId: string): void {
    this._sendControl({ type: "kill", name: ptyId });
    // Close session socket
    const sock = this._sessionSockets.get(ptyId);
    if (sock) {
      sock.destroy();
      this._sessionSockets.delete(ptyId);
      this._sessionDecoders.delete(ptyId);
    }
  }

  /** Clear the daemon's scrollback buffer for a PTY. */
  clearBuffer(ptyId: string): void {
    this._sendControl({ type: "clearBuffer", name: ptyId });
  }

  /** List all PTYs in the daemon. */
  async list(): Promise<PtyInfo[]> {
    const id = this._nextId();
    const response = await this._request({ type: "list", id });
    if (response.type === "ptyList") {
      const sessions = (response as any).sessions as Array<{
        name: string; pid: number; cwd: string; cols: number; rows: number; alive: boolean;
      }>;
      return sessions.map((s) => ({
        ptyId: s.name,
        pid: s.pid,
        processName: "",
        cwd: s.cwd,
        cols: s.cols,
        rows: s.rows,
      }));
    }
    throw new Error(`Unexpected response: ${response.type}`);
  }

  /**
   * Attach to an existing PTY, opening a raw data socket. The daemon
   * replays full scrollback as the first data received — use for a fresh
   * client that wants the history (new window, reload, cold connect).
   */
  async attach(ptyId: string, opts?: { rows?: number; cols?: number }): Promise<void> {
    await this._attachSession(ptyId, "attach", opts);
  }

  /**
   * Resume-only reattach: open the raw data socket WITHOUT replaying
   * scrollback. For a client that already holds the buffer and just needs
   * the live stream back (e.g. after a daemon handoff). Avoids the
   * full-buffer repaint that `attach` would cause on an already-populated
   * terminal. Requires daemon support for the `reattach` control type.
   */
  async reattach(ptyId: string, opts?: { rows?: number; cols?: number }): Promise<void> {
    await this._attachSession(ptyId, "reattach", opts);
  }

  /** Ping the daemon. Returns true if alive. */
  async ping(timeoutMs = 3000): Promise<boolean> {
    const id = this._nextId();
    try {
      const response = await this._request({ type: "ping", id }, timeoutMs);
      return response.type === "pong";
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _nextId(): number {
    return ++this._requestId;
  }

  private _sendControl(msg: ClientMessage): void {
    if (this._controlSocket && !this._controlSocket.destroyed) {
      this._controlSocket.write(encodeMessage(msg));
    }
  }

  private _request(msg: ClientMessage, timeoutMs = 10000): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      const id = (msg as { id?: number }).id;
      if (id === undefined) {
        reject(new Error("Message must have an id for request/response"));
        return;
      }
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }, timeoutMs);

      this._pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this._sendControl(msg);
    });
  }

  /** Wire up the control socket for ongoing message handling. */
  private _wireControlSocket(socket: net.Socket): void {
    socket.on("data", (chunk) => {
      const messages = this._controlDecoder.decode(chunk);
      for (const msg of messages) {
        this._handleControlMessage(msg as DaemonMessage);
      }
    });
  }

  /** Handle messages on the control socket (responses + events). */
  private _handleControlMessage(msg: DaemonMessage): void {
    // Correlate to a pending request ONLY for genuine response types.
    // loompty can push unsolicited `user_data` (and other) frames to every
    // authenticated client (PROTOCOL.md §4.12); those must never be mistaken
    // for a response just because they happen to carry a matching `id`.
    if (
      RESPONSE_TYPES.has(msg.type) &&
      "id" in msg &&
      msg.id !== undefined &&
      this._pending.has(msg.id)
    ) {
      const { resolve } = this._pending.get(msg.id)!;
      this._pending.delete(msg.id);
      resolve(msg);
      return;
    }

    // Asynchronous events from daemon
    switch (msg.type) {
      case "exit": {
        const name = (msg as any).name as string;
        const exitCode = (msg as any).exitCode as number;
        const signal = (msg as any).signal as number | undefined;
        this.emit("exit", name, exitCode, signal);
        // Clean up session socket
        const sock = this._sessionSockets.get(name);
        if (sock) {
          sock.destroy();
          this._sessionSockets.delete(name);
          this._sessionDecoders.delete(name);
        }
        break;
      }
      case "bell": {
        const name = (msg as any).name as string;
        this.emit("bell", name);
        break;
      }
    }
  }

  /**
   * Open a new connection to the daemon, authenticate, and attach to a
   * session. After the attach handshake, the socket transitions to raw
   * mode — all reads are PTY output, all writes go to PTY stdin.
   */
  private _attachSession(
    ptyId: string,
    mode: "attach" | "reattach" = "attach",
    opts?: { rows?: number; cols?: number },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Close existing session socket if any
      const existing = this._sessionSockets.get(ptyId);
      if (existing) {
        existing.destroy();
        this._sessionSockets.delete(ptyId);
        this._sessionDecoders.delete(ptyId);
      }

      const socket = net.createConnection(this._socketPath);
      let settled = false;

      socket.on("connect", () => {
        // Phase 1: authenticate
        socket.write(encodeMessage({ type: "auth", secret: this._secret }));

        const decoder = new FrameDecoder();
        let phase: "auth" | "attach" | "raw" = "auth";

        const onData = (chunk: Buffer) => {
          if (phase === "auth") {
            const messages = decoder.decode(chunk);
            for (const msg of messages) {
              const dm = msg as DaemonMessage;
              if (dm.type === "auth_ok") {
                phase = "attach";
                // Phase 2: send attach/reattach (with dims when known so
                // the daemon resizes before any replay — and corrects the
                // rows+1 it applies on handoff adopt).
                const attachId = this._nextId();
                socket.write(encodeMessage({
                  type: mode,
                  id: attachId,
                  name: ptyId,
                  ...(opts?.rows ? { rows: opts.rows } : {}),
                  ...(opts?.cols ? { cols: opts.cols } : {}),
                }));
                return;
              }
              if (dm.type === "error") {
                settled = true;
                reject(new Error(`Session auth failed: ${(dm as any).message}`));
                socket.destroy();
                return;
              }
            }
          } else if (phase === "attach") {
            // Feed raw bytes — don't use decode() because after the
            // framed "attached" response, remaining bytes are raw PTY
            // data (not framed). consumeAttachResponse handles this.
            decoder.feed(chunk);
            const result = decoder.consumeAttachResponse();
            if (result.message) {
              if (result.message.type === "error") {
                settled = true;
                reject(new Error(`Attach failed: ${(result.message as any).message}`));
                socket.destroy();
                return;
              }
              phase = "raw";
              // Transition to raw mode
              socket.removeListener("data", onData);
              this._sessionSockets.set(ptyId, socket);
              const strDecoder = new StringDecoder("utf8");
              this._sessionDecoders.set(ptyId, strDecoder);
              this._wireSessionSocket(ptyId, socket, strDecoder);

              // Process any trailing raw data (scrollback that arrived
              // in the same chunk as the attached frame)
              if (result.trailing.length > 0) {
                const str = strDecoder.write(result.trailing);
                if (str) {
                  this.emit("data", ptyId, str);
                }
              }

              settled = true;
              resolve();
            }
          }
        };

        socket.on("data", onData);
      });

      socket.on("close", () => {
        if (this._sessionSockets.get(ptyId) === socket) {
          this._sessionSockets.delete(ptyId);
          this._sessionDecoders.delete(ptyId);
        }
      });

      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  /** Wire a session socket for raw data streaming. */
  private _wireSessionSocket(
    ptyId: string,
    socket: net.Socket,
    strDecoder: StringDecoder,
  ): void {
    socket.on("data", (chunk: Buffer) => {
      const str = strDecoder.write(chunk);
      if (str) {
        this.emit("data", ptyId, str);
      }
    });

    socket.on("close", () => {
      // Flush any remaining bytes in the StringDecoder
      const remaining = strDecoder.end();
      if (remaining) {
        this.emit("data", ptyId, remaining);
      }
      if (this._sessionSockets.get(ptyId) === socket) {
        this._sessionSockets.delete(ptyId);
        this._sessionDecoders.delete(ptyId);
      }
    });

    socket.on("error", (err) => {
      Logger.warn(`Session socket error for ${ptyId}: ${(err as Error)?.message || err}`);
    });
  }
}

/** Shell-escape a value for use in `env KEY=VALUE` command prefix. */
export function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(s)) {
    return s;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
