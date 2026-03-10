/**
 * PTY Daemon Client — used by the extension host to communicate with the
 * daemon process over a Unix domain socket or named pipe.
 *
 * Provides the same logical operations as direct PTY management but routes
 * them through the daemon, enabling PTY persistence across reloads.
 */

import * as net from "net";
import { EventEmitter } from "events";
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
  replayStart: (ptyId: string) => void;
  replayEnd: (ptyId: string) => void;
  disconnected: () => void;
}

export class PtyDaemonClient extends EventEmitter {
  private _socket: net.Socket | null = null;
  private _decoder = new FrameDecoder();
  private _requestId = 0;
  private _pending = new Map<number, { resolve: (msg: DaemonMessage) => void; reject: (err: Error) => void }>();
  private _sessionId: string;
  private _secret: string;
  private _connected = false;

  constructor(sessionId: string, secret: string) {
    super();
    this._sessionId = sessionId;
    this._secret = secret;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the daemon socket and authenticate. */
  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;

      socket.on("connect", () => {
        this._socket = socket;
        this._connected = true;
        this._decoder.reset();
        // Authenticate immediately with the shared secret
        this._send({
          type: "ping",
          id: 0,
          sessionId: this._sessionId,
          secret: this._secret,
        } as any);
        settled = true;
        resolve();
      });

      socket.on("data", (chunk) => {
        const messages = this._decoder.decode(chunk);
        for (const msg of messages) {
          this._handleMessage(msg as DaemonMessage);
        }
      });

      socket.on("close", () => {
        this._connected = false;
        this._socket = null;
        // Reject all pending requests
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
    if (this._socket && !this._socket.destroyed) {
      this._send({ type: "detach", sessionId: this._sessionId });
      this._socket.end();
    }
    this._connected = false;
    this._socket = null;
  }

  /** Spawn a new PTY in the daemon. */
  async spawn(
    ptyId: string,
    shell: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): Promise<{ pid: number }> {
    const id = this._nextId();
    const response = await this._request({
      type: "spawn",
      id,
      sessionId: this._sessionId,
      ptyId,
      shell,
      args,
      cwd,
      env,
      cols,
      rows,
    });
    if (response.type === "error") {
      throw new Error(response.message);
    }
    if (response.type === "spawned") {
      return { pid: response.pid };
    }
    throw new Error(`Unexpected response: ${response.type}`);
  }

  /** Write data to a PTY's stdin. */
  write(ptyId: string, data: string): void {
    this._send({ type: "write", ptyId, data });
  }

  /** Resize a PTY. */
  resize(ptyId: string, cols: number, rows: number): void {
    this._send({ type: "resize", ptyId, cols, rows });
  }

  /** Kill a PTY. */
  kill(ptyId: string): void {
    this._send({ type: "kill", ptyId });
  }

  /** List all PTYs belonging to this session. */
  async list(): Promise<PtyInfo[]> {
    const id = this._nextId();
    const response = await this._request({
      type: "list",
      id,
      sessionId: this._sessionId,
    });
    if (response.type === "ptyList") {
      return response.ptys;
    }
    throw new Error(`Unexpected response: ${response.type}`);
  }

  /** Reattach to an existing PTY, triggering buffered output replay. */
  async attach(ptyId: string): Promise<void> {
    const id = this._nextId();
    // Don't await a request/response — attach triggers replay messages
    // which are handled as events, not as a single response.
    this._send({
      type: "attach",
      id,
      sessionId: this._sessionId,
      ptyId,
    });
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

  private _send(msg: ClientMessage): void {
    if (this._socket && !this._socket.destroyed) {
      this._socket.write(encodeMessage(msg));
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

      this._send(msg);
    });
  }

  private _handleMessage(msg: DaemonMessage): void {
    // Check if this is a response to a pending request
    if ("id" in msg && msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve } = this._pending.get(msg.id)!;
      this._pending.delete(msg.id);
      resolve(msg);
      return;
    }

    // Event-based messages
    switch (msg.type) {
      case "data":
        this.emit("data", msg.ptyId, msg.data);
        break;
      case "exit":
        this.emit("exit", msg.ptyId, msg.exitCode, msg.signal);
        break;
      case "replayStart":
        this.emit("replayStart", msg.ptyId);
        break;
      case "replayEnd":
        this.emit("replayEnd", msg.ptyId);
        break;
    }
  }
}
