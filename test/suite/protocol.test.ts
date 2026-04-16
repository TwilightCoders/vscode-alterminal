import * as assert from "assert";
import {
  encodeMessage,
  FrameDecoder,
  type ClientMessage,
  type DaemonMessage,
} from "../../src/daemon/protocol";

suite("Protocol", () => {

  suite("encodeMessage", () => {
    test("produces a 4-byte big-endian length prefix", () => {
      const buf = encodeMessage({ type: "ping", id: 1 });
      const payloadLen = buf.readUInt32BE(0);
      assert.strictEqual(buf.length, 4 + payloadLen);
    });

    test("payload is valid JSON", () => {
      const buf = encodeMessage({ type: "ping", id: 42 });
      const json = buf.subarray(4).toString("utf8");
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.type, "ping");
      assert.strictEqual(parsed.id, 42);
    });
  });

  suite("FrameDecoder", () => {

    suite("decode", () => {
      test("decodes a single complete frame", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "pong", id: 1 });
        const msgs = decoder.decode(frame);
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual((msgs[0] as any).type, "pong");
        assert.strictEqual((msgs[0] as any).id, 1);
      });

      test("decodes multiple frames in one chunk", () => {
        const decoder = new FrameDecoder();
        const f1 = encodeMessage({ type: "pong", id: 1 });
        const f2 = encodeMessage({ type: "pong", id: 2 });
        const combined = Buffer.concat([f1, f2]);
        const msgs = decoder.decode(combined);
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual((msgs[0] as any).id, 1);
        assert.strictEqual((msgs[1] as any).id, 2);
      });

      test("handles partial frame across two chunks", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "pong", id: 7 });
        const split = Math.floor(frame.length / 2);

        const msgs1 = decoder.decode(frame.subarray(0, split));
        assert.strictEqual(msgs1.length, 0);

        const msgs2 = decoder.decode(frame.subarray(split));
        assert.strictEqual(msgs2.length, 1);
        assert.strictEqual((msgs2[0] as any).id, 7);
      });

      test("handles partial header (less than 4 bytes)", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "ping", id: 1 });

        // Send only 2 bytes
        const msgs1 = decoder.decode(frame.subarray(0, 2));
        assert.strictEqual(msgs1.length, 0);

        // Send the rest
        const msgs2 = decoder.decode(frame.subarray(2));
        assert.strictEqual(msgs2.length, 1);
      });

      test("discards stream on oversized payload", () => {
        const decoder = new FrameDecoder();
        // Craft a header claiming 11MB payload
        const badHeader = Buffer.alloc(4);
        badHeader.writeUInt32BE(11 * 1024 * 1024, 0);
        const msgs = decoder.decode(Buffer.concat([badHeader, Buffer.alloc(100)]));
        assert.strictEqual(msgs.length, 0);

        // Decoder should recover — subsequent valid frames work
        const good = encodeMessage({ type: "pong", id: 99 });
        const msgs2 = decoder.decode(good);
        assert.strictEqual(msgs2.length, 1);
        assert.strictEqual((msgs2[0] as any).id, 99);
      });

      test("skips malformed JSON frames", () => {
        const decoder = new FrameDecoder();
        const badJson = Buffer.from("not json {{{");
        const frame = Buffer.alloc(4 + badJson.length);
        frame.writeUInt32BE(badJson.length, 0);
        badJson.copy(frame, 4);

        const msgs = decoder.decode(frame);
        assert.strictEqual(msgs.length, 0);
      });

      test("returns empty array for empty chunk", () => {
        const decoder = new FrameDecoder();
        const msgs = decoder.decode(Buffer.alloc(0));
        assert.strictEqual(msgs.length, 0);
      });
    });

    suite("feed + consumeAttachResponse", () => {
      test("consumes a single framed response", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "attached", id: 1, name: "s1", scrollbackBytes: 0 } as any);
        decoder.feed(frame);

        const result = decoder.consumeAttachResponse();
        assert.ok(result.message);
        assert.strictEqual((result.message as any).type, "attached");
        assert.strictEqual(result.trailing.length, 0);
      });

      test("separates framed response from trailing raw bytes", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "attached", id: 1, name: "s1", scrollbackBytes: 5 } as any);
        const rawData = Buffer.from("hello");
        decoder.feed(Buffer.concat([frame, rawData]));

        const result = decoder.consumeAttachResponse();
        assert.ok(result.message);
        assert.strictEqual((result.message as any).type, "attached");
        assert.strictEqual(result.trailing.toString(), "hello");
      });

      test("returns null when frame is incomplete", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "attached", id: 1, name: "s1", scrollbackBytes: 0 } as any);
        // Feed only part of the frame
        decoder.feed(frame.subarray(0, 6));

        const result = decoder.consumeAttachResponse();
        assert.strictEqual(result.message, null);
        assert.strictEqual(result.trailing.length, 0);
      });

      test("returns null when buffer has less than header size", () => {
        const decoder = new FrameDecoder();
        decoder.feed(Buffer.from([0x00, 0x00]));
        const result = decoder.consumeAttachResponse();
        assert.strictEqual(result.message, null);
      });

      test("handles oversized payload claim gracefully", () => {
        const decoder = new FrameDecoder();
        const badHeader = Buffer.alloc(4);
        badHeader.writeUInt32BE(11 * 1024 * 1024, 0);
        decoder.feed(badHeader);
        const result = decoder.consumeAttachResponse();
        assert.strictEqual(result.message, null);
      });

      test("feed accumulates across multiple calls", () => {
        const decoder = new FrameDecoder();
        const frame = encodeMessage({ type: "attached", id: 3, name: "s3", scrollbackBytes: 10 } as any);
        const raw = Buffer.from("scrollback");
        const combined = Buffer.concat([frame, raw]);

        // Feed in three pieces
        decoder.feed(combined.subarray(0, 4));
        decoder.feed(combined.subarray(4, frame.length));
        decoder.feed(combined.subarray(frame.length));

        const result = decoder.consumeAttachResponse();
        assert.ok(result.message);
        assert.strictEqual((result.message as any).id, 3);
        assert.strictEqual(result.trailing.toString(), "scrollback");
      });
    });

    suite("reset", () => {
      test("clears accumulated buffer", () => {
        const decoder = new FrameDecoder();
        // Feed partial data
        decoder.feed(Buffer.from([0x00, 0x00, 0x00, 0x0a]));
        decoder.reset();

        // Now feed a valid frame — it should decode cleanly
        const frame = encodeMessage({ type: "pong", id: 1 });
        const msgs = decoder.decode(frame);
        assert.strictEqual(msgs.length, 1);
      });
    });

    suite("round-trip", () => {
      test("encode → decode round-trips all message types", () => {
        const messages: (ClientMessage | DaemonMessage)[] = [
          { type: "auth", secret: "abc123" },
          { type: "spawn", id: 1, name: "s1", command: "/bin/zsh", cwd: "/tmp", cols: 80, rows: 24 },
          { type: "write", name: "s1", data: "hello\r\n" },
          { type: "resize", name: "s1", cols: 120, rows: 40 },
          { type: "kill", name: "s1" },
          { type: "list", id: 2 },
          { type: "attach", id: 3, name: "s1" },
          { type: "ping", id: 4 },
          { type: "auth_ok" } as DaemonMessage,
          { type: "pong", id: 5 } as DaemonMessage,
          { type: "error", id: 6, message: "something broke" } as DaemonMessage,
        ];

        const decoder = new FrameDecoder();
        for (const msg of messages) {
          const frame = encodeMessage(msg);
          const decoded = decoder.decode(frame);
          assert.strictEqual(decoded.length, 1);
          assert.deepStrictEqual(decoded[0], msg);
        }
      });
    });
  });
});
