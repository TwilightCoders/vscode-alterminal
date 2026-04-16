import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  workspaceHash,
  readLockfile,
  writeLockfile,
  removeLockfile,
  writeSecret,
  readSecret,
  removeSecret,
  generateSecret,
  isProcessAlive,
} from "../../src/daemon/lockfile";

suite("Lockfile Utilities", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alterminal-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  suite("workspaceHash", () => {
    test("produces a 12-character hex string", () => {
      const hash = workspaceHash(["/Users/volte/project"]);
      assert.match(hash, /^[0-9a-f]{12}$/);
    });

    test("is deterministic", () => {
      const a = workspaceHash(["/a", "/b"]);
      const b = workspaceHash(["/a", "/b"]);
      assert.strictEqual(a, b);
    });

    test("is order-independent", () => {
      const a = workspaceHash(["/a", "/b"]);
      const b = workspaceHash(["/b", "/a"]);
      assert.strictEqual(a, b);
    });

    test("produces different hashes for different inputs", () => {
      const a = workspaceHash(["/project-a"]);
      const b = workspaceHash(["/project-b"]);
      assert.notStrictEqual(a, b);
    });
  });

  suite("readLockfile / writeLockfile", () => {
    test("round-trips lockfile data", () => {
      const lockPath = path.join(tmpDir, "test.json");
      const info = { pid: 12345, socketPath: "/tmp/test.sock", version: "1" };
      writeLockfile(lockPath, info);

      const result = readLockfile(lockPath);
      assert.ok(result);
      assert.strictEqual(result!.pid, 12345);
      assert.strictEqual(result!.socketPath, "/tmp/test.sock");
      assert.strictEqual(result!.version, "1");
    });

    test("returns null for missing file", () => {
      const result = readLockfile(path.join(tmpDir, "nonexistent.json"));
      assert.strictEqual(result, null);
    });

    test("returns null for corrupt JSON", () => {
      const lockPath = path.join(tmpDir, "corrupt.json");
      fs.writeFileSync(lockPath, "not json {{{");
      assert.strictEqual(readLockfile(lockPath), null);
    });

    test("returns null for JSON missing required fields", () => {
      const lockPath = path.join(tmpDir, "partial.json");
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 1 }));
      assert.strictEqual(readLockfile(lockPath), null);
    });

    test("lockfile has restricted permissions", () => {
      const lockPath = path.join(tmpDir, "perms.json");
      writeLockfile(lockPath, { pid: 1, socketPath: "/s", version: "1" });
      const stat = fs.statSync(lockPath);
      // Owner read/write only (0o600)
      assert.strictEqual(stat.mode & 0o777, 0o600);
    });
  });

  suite("removeLockfile", () => {
    test("removes an existing lockfile", () => {
      const lockPath = path.join(tmpDir, "remove-me.json");
      fs.writeFileSync(lockPath, "{}");
      removeLockfile(lockPath);
      assert.ok(!fs.existsSync(lockPath));
    });

    test("does not throw for missing file", () => {
      assert.doesNotThrow(() => {
        removeLockfile(path.join(tmpDir, "already-gone.json"));
      });
    });
  });

  suite("writeSecret / readSecret / removeSecret", () => {
    test("round-trips a secret", () => {
      const secretFile = path.join(tmpDir, "test.secret");
      writeSecret(secretFile, "my-secret-value");
      assert.strictEqual(readSecret(secretFile), "my-secret-value");
    });

    test("secret file has restricted permissions", () => {
      const secretFile = path.join(tmpDir, "perms.secret");
      writeSecret(secretFile, "s3cret");
      const stat = fs.statSync(secretFile);
      assert.strictEqual(stat.mode & 0o777, 0o600);
    });

    test("readSecret returns null for missing file", () => {
      assert.strictEqual(readSecret(path.join(tmpDir, "nope.secret")), null);
    });

    test("removeSecret removes the file", () => {
      const secretFile = path.join(tmpDir, "rm.secret");
      writeSecret(secretFile, "bye");
      removeSecret(secretFile);
      assert.ok(!fs.existsSync(secretFile));
    });

    test("removeSecret does not throw for missing file", () => {
      assert.doesNotThrow(() => {
        removeSecret(path.join(tmpDir, "already-gone.secret"));
      });
    });
  });

  suite("generateSecret", () => {
    test("produces a 32-character hex string", () => {
      const secret = generateSecret();
      assert.match(secret, /^[0-9a-f]{32}$/);
    });

    test("produces unique values", () => {
      const a = generateSecret();
      const b = generateSecret();
      assert.notStrictEqual(a, b);
    });
  });

  suite("isProcessAlive", () => {
    test("returns true for current process", () => {
      assert.strictEqual(isProcessAlive(process.pid), true);
    });

    test("returns false for a non-existent PID", () => {
      // PID 999999 is very unlikely to exist
      assert.strictEqual(isProcessAlive(999999), false);
    });
  });
});
