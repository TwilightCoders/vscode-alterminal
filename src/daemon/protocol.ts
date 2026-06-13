/**
 * IPC protocol for extension <-> loomptyd (loompty's PTY daemon) communication.
 *
 * Wire format: 4-byte big-endian length prefix + UTF-8 JSON payload.
 *
 * After an "attach" command, the connection transitions to raw mode:
 * the daemon sends one framed JSON "attached" response, then all
 * subsequent data on that socket is raw PTY output (and writes go
 * directly to PTY stdin).
 */

// ---------------------------------------------------------------------------
// Client → Daemon
// ---------------------------------------------------------------------------

export type ClientMessage =
  | AuthMessage
  | SpawnMessage
  | WriteMessage
  | ResizeMessage
  | KillMessage
  | ListMessage
  | AttachMessage
  | ReattachMessage
  | DetachMessage
  | ClearBufferMessage
  | PingMessage
  | HandoffMessage;

export interface AuthMessage {
  type: "auth";
  secret: string;
}

export interface SpawnMessage {
  type: "spawn";
  id: number;
  name: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface WriteMessage {
  type: "write";
  name: string;
  data: string;
}

export interface ResizeMessage {
  type: "resize";
  name: string;
  cols: number;
  rows: number;
}

export interface KillMessage {
  type: "kill";
  name: string;
}

export interface ListMessage {
  type: "list";
  id: number;
}

export interface AttachMessage {
  type: "attach";
  id: number;
  name: string;
  rows?: number;
  cols?: number;
}

/**
 * Like attach, but resume-only: open the raw session socket WITHOUT
 * replaying scrollback. For a client that already holds the buffer and
 * just needs the live stream reconnected (e.g. after a daemon handoff).
 */
export interface ReattachMessage {
  type: "reattach";
  id: number;
  name: string;
  rows?: number;
  cols?: number;
}

export interface DetachMessage {
  type: "detach";
}

export interface ClearBufferMessage {
  type: "clearBuffer";
  name: string;
}

export interface PingMessage {
  type: "ping";
  id: number;
}

export interface HandoffMessage {
  type: "handoff";
  /** Path of the successor daemon's handoff-listen socket (PROTOCOL §4.11). */
  socket: string;
}

// ---------------------------------------------------------------------------
// Daemon → Client
// ---------------------------------------------------------------------------

export type DaemonMessage =
  | AuthOkMessage
  | DataMessage
  | ExitMessage
  | BellMessage
  | SpawnedMessage
  | PtyListMessage
  | AttachedMessage
  | PongMessage
  | ErrorMessage;

export interface AuthOkMessage {
  type: "auth_ok";
}

export interface DataMessage {
  type: "data";
  name: string;
  data: string;
}

export interface ExitMessage {
  type: "exit";
  name: string;
  exitCode: number;
  signal?: number;
}

export interface BellMessage {
  type: "bell";
  name: string;
}

export interface SpawnedMessage {
  type: "spawned";
  id: number;
  name: string;
  pid: number;
}

export interface PtyListSession {
  name: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
}

export interface PtyListMessage {
  type: "ptyList";
  id: number;
  sessions: PtyListSession[];
}

export interface AttachedMessage {
  type: "attached";
  id: number;
  name: string;
  scrollbackBytes: number;
}

export interface PongMessage {
  type: "pong";
  id: number;
}

export interface ErrorMessage {
  type: "error";
  id?: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Public types (used by ptyManager — uses "ptyId" terminology)
// ---------------------------------------------------------------------------

export interface PtyInfo {
  ptyId: string;
  pid: number;
  processName: string;
  cwd: string;
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// Frame codec — length-prefixed JSON
// ---------------------------------------------------------------------------

const HEADER_SIZE = 4;

/** Encode a message into a length-prefixed buffer. */
export function encodeMessage(msg: ClientMessage | DaemonMessage): Buffer {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

/** Maximum payload size (10MB — well beyond normal terminal output). */
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;

/**
 * Streaming decoder that accumulates incoming data and yields complete
 * messages as they arrive. Handles partial reads and multiple messages
 * per chunk.
 */
export class FrameDecoder {
  private _buffer: Buffer = Buffer.alloc(0);

  /** Feed raw socket data, returns zero or more decoded messages. */
  decode(chunk: Buffer): (ClientMessage | DaemonMessage)[] {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    const messages: (ClientMessage | DaemonMessage)[] = [];

    while (this._buffer.length >= HEADER_SIZE) {
      const payloadLen = this._buffer.readUInt32BE(0);
      if (payloadLen > MAX_PAYLOAD_SIZE) {
        // Discard corrupted stream — caller should close the connection
        this._buffer = Buffer.alloc(0);
        break;
      }
      const totalLen = HEADER_SIZE + payloadLen;
      if (this._buffer.length < totalLen) {
        break; // incomplete frame, wait for more data
      }
      const json = this._buffer.subarray(HEADER_SIZE, totalLen).toString("utf8");
      this._buffer = this._buffer.subarray(totalLen);
      try {
        messages.push(JSON.parse(json));
      } catch {
        // Malformed JSON — skip this frame
      }
    }

    return messages;
  }

  /**
   * Append raw data to the internal buffer without parsing frames.
   * Use with consumeAttachResponse() during the attach handshake.
   */
  feed(chunk: Buffer): void {
    this._buffer = Buffer.concat([this._buffer, chunk]);
  }

  /**
   * Consume the attached response frame and return any trailing raw bytes.
   * Used during the attach handshake — after the framed "attached" JSON
   * response, remaining bytes are raw PTY data (not framed).
   * Call feed() first to append data, then this to extract the response.
   */
  consumeAttachResponse(): { message: DaemonMessage | null; trailing: Buffer } {
    if (this._buffer.length < HEADER_SIZE) {
      return { message: null, trailing: Buffer.alloc(0) };
    }
    const payloadLen = this._buffer.readUInt32BE(0);
    if (payloadLen > MAX_PAYLOAD_SIZE) {
      this._buffer = Buffer.alloc(0);
      return { message: null, trailing: Buffer.alloc(0) };
    }
    const totalLen = HEADER_SIZE + payloadLen;
    if (this._buffer.length < totalLen) {
      return { message: null, trailing: Buffer.alloc(0) };
    }
    const json = this._buffer.subarray(HEADER_SIZE, totalLen).toString("utf8");
    const trailing = Buffer.from(this._buffer.subarray(totalLen));
    this._buffer = Buffer.alloc(0);
    try {
      return { message: JSON.parse(json), trailing };
    } catch {
      return { message: null, trailing };
    }
  }

  reset(): void {
    this._buffer = Buffer.alloc(0);
  }
}
