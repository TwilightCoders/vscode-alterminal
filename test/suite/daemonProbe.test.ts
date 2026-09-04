import * as assert from "assert";
import {
  decideAfterConnectFailure,
  daemonStateFromProbeExit,
  probePermitsReap,
  ConnectFailure,
} from "../../src/daemon/daemonProbe";

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

suite("daemonProbe exit codes", () => {
  // loomptyd --probe is deliberately NOT 0-is-success. This is the exact
  // inversion a well-meaning refactor "corrects", so pin it.
  test("maps loomptyd --probe exit codes", () => {
    assert.strictEqual(daemonStateFromProbeExit(0), "live");
    assert.strictEqual(daemonStateFromProbeExit(3), "none");
    assert.strictEqual(daemonStateFromProbeExit(4), "unknown");
    assert.strictEqual(daemonStateFromProbeExit(2), "unknown", "usage error is not an answer");
  });

  // The property that makes the scheme safe by construction rather than by
  // discipline: a missing binary (127), a crash (139), a signal, a timeout
  // (null) — none of them may authorise destroying a live daemon's files.
  test("only exit 3 ever authorises a reap", () => {
    const codes = [0, 1, 2, 4, 5, 126, 127, 139, 255, -1, null];
    for (const c of codes) {
      assert.strictEqual(
        probePermitsReap(daemonStateFromProbeExit(c)),
        false,
        `exit ${c} must not authorise a reap`,
      );
    }
    assert.strictEqual(probePermitsReap(daemonStateFromProbeExit(3)), true);
  });

  // The regression that would have shipped a total outage: loomptyd 0.4.5
  // rejects --probe with exit 1. Folded into "unknown", that means never-reap
  // AND never-spawn, so an extension carrying an older vendored daemon would
  // refuse to start one at all — no PTY persistence whatsoever.
  test("an older daemon without --probe is 'unsupported', not 'unknown'", () => {
    assert.strictEqual(daemonStateFromProbeExit(1), "unsupported");
    assert.notStrictEqual(daemonStateFromProbeExit(1), "unknown");
  });

  test("unsupported does not itself authorise a reap", () => {
    assert.strictEqual(probePermitsReap("unsupported"), false);
  });

  test("an unanswerable probe is treated as live", () => {
    assert.strictEqual(daemonStateFromProbeExit(null), "unknown");
    assert.strictEqual(probePermitsReap("unknown"), false);
    assert.strictEqual(probePermitsReap("live"), false);
  });
});
