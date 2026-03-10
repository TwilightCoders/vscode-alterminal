/**
 * IPC protocol for extension <-> PTY daemon communication.
 *
 * Wire format: 4-byte big-endian length prefix + UTF-8 JSON payload.
 * This avoids delimiter issues since PTY output can contain arbitrary bytes.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/** Client → Daemon */
export type ClientMessage =
  | SpawnMessage
  | WriteMessage
  | ResizeMessage
  | KillMessage
  | ListMessage
  | AttachMessage
  | DetachMessage
  | PingMessage;

/** Daemon → Client */
export type DaemonMessage =
  | DataMessage
  | ExitMessage
  | SpawnedMessage
  | PtyListMessage
  | ReplayStartMessage
  | ReplayEndMessage
  | PongMessage
  | ErrorMessage;

// --- Client → Daemon -------------------------------------------------------

export interface SpawnMessage {
  type: "spawn";
  id: number;
  sessionId: string;
  ptyId: string;
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface WriteMessage {
  type: "write";
  ptyId: string;
  data: string;
}

export interface ResizeMessage {
  type: "resize";
  ptyId: string;
  cols: number;
  rows: number;
}

export interface KillMessage {
  type: "kill";
  ptyId: string;
}

export interface ListMessage {
  type: "list";
  id: number;
  sessionId: string;
}

export interface AttachMessage {
  type: "attach";
  id: number;
  sessionId: string;
  ptyId: string;
}

export interface DetachMessage {
  type: "detach";
  sessionId: string;
}

export interface PingMessage {
  type: "ping";
  id: number;
}

// --- Daemon → Client -------------------------------------------------------

export interface DataMessage {
  type: "data";
  ptyId: string;
  data: string;
}

export interface ExitMessage {
  type: "exit";
  ptyId: string;
  exitCode: number;
  signal?: number;
}

export interface SpawnedMessage {
  type: "spawned";
  id: number;
  ptyId: string;
  pid: number;
}

export interface PtyInfo {
  ptyId: string;
  pid: number;
  processName: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyListMessage {
  type: "ptyList";
  id: number;
  ptys: PtyInfo[];
}

export interface ReplayStartMessage {
  type: "replayStart";
  ptyId: string;
}

export interface ReplayEndMessage {
  type: "replayEnd";
  ptyId: string;
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
// Lockfile
// ---------------------------------------------------------------------------

export interface DaemonLockfile {
  pid: number;
  socketPath: string;
  version: string;
  secret: string;
  startedAt: number;
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

  reset(): void {
    this._buffer = Buffer.alloc(0);
  }
}
