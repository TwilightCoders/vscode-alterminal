import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  workspaceHash,
  pidfilePath,
  socketPath,
  readPidfile,
  removePidfile,
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

  suite("pidfilePath", () => {
    test("is the socket path with a .pid suffix (loomptyd's auto-derived pidfile)", () => {
      const hash = workspaceHash(["/some/project"]);
      assert.strictEqual(pidfilePath(hash), socketPath(hash) + ".pid");
    });
  });

  suite("readPidfile", () => {
    test("reads a plain decimal pid", () => {
      const pidPath = path.join(tmpDir, "test.sock.pid");
      fs.writeFileSync(pidPath, "12345\n");
      assert.strictEqual(readPidfile(pidPath), 12345);
    });

    test("tolerates no trailing newline", () => {
      const pidPath = path.join(tmpDir, "nonl.sock.pid");
      fs.writeFileSync(pidPath, "678");
      assert.strictEqual(readPidfile(pidPath), 678);
    });

    test("returns null for a missing file", () => {
      assert.strictEqual(readPidfile(path.join(tmpDir, "nope.sock.pid")), null);
    });

    test("returns null for an empty file (daemon created it but hasn't written the pid)", () => {
      const pidPath = path.join(tmpDir, "empty.sock.pid");
      fs.writeFileSync(pidPath, "");
      assert.strictEqual(readPidfile(pidPath), null);
    });

    test("returns null for non-numeric / zero / negative contents", () => {
      for (const bad of ["garbage", "0", "-1", "  "]) {
        const pidPath = path.join(tmpDir, `bad-${Buffer.from(bad).toString("hex")}.sock.pid`);
        fs.writeFileSync(pidPath, bad);
        assert.strictEqual(readPidfile(pidPath), null, `expected null for ${JSON.stringify(bad)}`);
      }
    });
  });

  suite("removePidfile", () => {
    test("removes an existing pidfile", () => {
      const pidPath = path.join(tmpDir, "remove-me.sock.pid");
      fs.writeFileSync(pidPath, "1\n");
      removePidfile(pidPath);
      assert.ok(!fs.existsSync(pidPath));
    });

    test("does not throw for a missing file", () => {
      assert.doesNotThrow(() => {
        removePidfile(path.join(tmpDir, "already-gone.sock.pid"));
      });
    });
  });

  suite("writeSecret / readSecret / removeSecret", () => {
    test("round-trips a secret", () => {
      const secretFile = path.join(tmpDir, "test.secret");
      writeSecret(secretFile, "my-secret-value");
      assert.strictEqual(readSecret(secretFile), "my-secret-value");
    });

    test("secret file has restricted permissions", function () {
      // POSIX-only. Windows has no mode bits — NTFS uses ACLs, and Node reports
      // a synthetic 0o666/0o444, so `mode & 0o777 === 0o600` cannot hold there
      // no matter how the file is created. Nothing to assert rather than
      // something weaker: the daemon this secret belongs to is POSIX-only
      // (unix sockets, SCM_RIGHTS, flock), so this path never runs on Windows.
      // If a Windows daemon ever ships, this needs an ACL assertion, not a
      // relaxed mode check.
      if (process.platform === "win32") {
        this.skip();
      }
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

  suite("runtime directory (socket + pidfile location)", () => {
    const saved = process.env.ALTERMINAL_RUNTIME_DIR;
    teardown(() => {
      if (saved === undefined) delete process.env.ALTERMINAL_RUNTIME_DIR;
      else process.env.ALTERMINAL_RUNTIME_DIR = saved;
    });

    test("ALTERMINAL_RUNTIME_DIR overrides the platform default", () => {
      const dir = path.join(tmpDir, "override-run");
      process.env.ALTERMINAL_RUNTIME_DIR = dir;
      assert.ok(socketPath("abc123").startsWith(dir));
    });

    test("the socket is NOT placed in the OS temp dir", function () {
      // The bug this guards: on macOS os.tmpdir() is /var/folders/../T, which
      // the OS purges of files untouched for ~3 days. A daemon that outlived
      // that window lost its socket and pidfile, so the flock single-instance
      // guard silently stopped working and the next start squatted the path,
      // stranding five live shells. Anything reaped by the OS is disqualified.
      if (process.platform === "win32") this.skip();
      delete process.env.ALTERMINAL_RUNTIME_DIR;
      const sock = socketPath("abc123");
      assert.ok(
        !sock.startsWith(os.tmpdir()),
        `socket must not live in the reapable temp dir, got ${sock}`,
      );
    });

    test("the pidfile sits beside the socket", () => {
      // loomptyd derives its pidfile as <socket>.pid, so they must share a
      // directory — putting them in different places breaks discovery.
      const dir = path.join(tmpDir, "beside-run");
      process.env.ALTERMINAL_RUNTIME_DIR = dir;
      assert.strictEqual(pidfilePath("abc123"), socketPath("abc123") + ".pid");
      assert.strictEqual(path.dirname(pidfilePath("abc123")), path.dirname(socketPath("abc123")));
    });

    test("socket path stays under the AF_UNIX length limit", function () {
      // macOS caps sun_path near 104 bytes; exceeding it fails at bind with
      // EINVAL, which is how the VS Code test harness broke on Linux CI.
      if (process.platform === "win32") this.skip();
      delete process.env.ALTERMINAL_RUNTIME_DIR;
      assert.ok(socketPath("abcdef123456").length < 104, socketPath("abcdef123456"));
    });
  });

});
