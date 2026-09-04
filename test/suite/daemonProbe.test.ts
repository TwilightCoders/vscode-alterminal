import * as assert from "assert";
import { decideAfterConnectFailure, ConnectFailure } from "../../src/daemon/daemonProbe";

suite("daemonProbe", () => {
  // THE regression. loompty's handoff is structurally discontinuous: the
  // successor adopts the sessions, then waits for the predecessor's socket to
  // go quiet before binding its own, so nothing listens in between. The pidfile
  // rides across on SCM_RIGHTS and stays valid the whole time. A client that
  // connects in that window therefore sees a LIVE pid and a refused socket —
  // and the old code reaped the pidfile, the secret, and the socket of a
  // running daemon that was holding every live session.
  test("never reaps a live daemon that refused the connection", () => {
    const d = decideAfterConnectFailure("unreachable");
    assert.strictEqual(d.reap, false, "reaping a live daemon's files strands its sessions");
    assert.strictEqual(d.retry, true);
  });

  // Unlinking the socket is the worst of the three: a healthy daemon goes from
  // briefly unreachable to permanently unreachable.
  test("never spawns a rival while a live daemon is unreachable", () => {
    assert.strictEqual(decideAfterConnectFailure("unreachable").spawn, false);
  });

  // A live pid with no secret is a daemon mid-spawn, still writing its files.
  test("waits out a daemon that has not written its secret yet", () => {
    const d = decideAfterConnectFailure("no-secret");
    assert.strictEqual(d.reap, false);
    assert.strictEqual(d.retry, true);
    assert.strictEqual(d.spawn, false);
  });

  // The one case where reaping is right.
  test("reaps only when the pid is genuinely gone", () => {
    const d = decideAfterConnectFailure("dead-process");
    assert.strictEqual(d.reap, true);
    assert.strictEqual(d.spawn, true);
    assert.strictEqual(d.retry, false);
  });

  test("spawns immediately when there is no pidfile at all", () => {
    const d = decideAfterConnectFailure("no-pidfile");
    assert.strictEqual(d.reap, false, "nothing to reap");
    assert.strictEqual(d.spawn, true);
  });

  // Reaping and spawning are both destructive-ish; neither may ever pair with
  // "wait, it's probably fine".
  test("retry is never combined with reap or spawn", () => {
    const all: ConnectFailure[] = ["no-pidfile", "dead-process", "no-secret", "unreachable"];
    for (const f of all) {
      const d = decideAfterConnectFailure(f);
      if (d.retry) {
        assert.strictEqual(d.reap, false, `${f}: retry must not reap`);
        assert.strictEqual(d.spawn, false, `${f}: retry must not spawn`);
      }
    }
  });

  test("reap is only ever permitted for a dead process", () => {
    const all: ConnectFailure[] = ["no-pidfile", "dead-process", "no-secret", "unreachable"];
    for (const f of all) {
      if (decideAfterConnectFailure(f).reap) {
        assert.strictEqual(f, "dead-process", `${f} must not reap daemon state`);
      }
    }
  });
});
