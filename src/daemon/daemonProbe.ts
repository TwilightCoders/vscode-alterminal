/**
 * What a failed daemon connection attempt MEANS, and what may be done about it.
 *
 * Extracted as a pure decision because the dangerous case is invisible in
 * normal operation: a daemon that is alive but momentarily unreachable looks
 * exactly like a dead one at the call site, and the old code treated them the
 * same — it deleted the pidfile, the secret, and unlinked the socket of a live,
 * session-holding daemon.
 *
 * That is not hypothetical. loompty's daemon handoff is structurally
 * discontinuous: the successor adopts the sessions, then waits for the
 * predecessor's socket to stop answering before it binds its own (the
 * single-instance guard requires observing the predecessor gone). Nothing
 * listens in that window. The pidfile, meanwhile, rides across the handoff on
 * SCM_RIGHTS and stays valid throughout — so a client connecting mid-handoff
 * sees a live pid and a refused connection, which is precisely the shape that
 * used to trigger the reap.
 *
 * Unlinking the socket is the worst of the three: it makes a healthy daemon
 * permanently unreachable rather than briefly so.
 */

export type ConnectFailure =
  /** No pidfile at all — nothing is running. */
  | "no-pidfile"
  /** Pidfile names a process that is gone — genuine crash leftovers. */
  | "dead-process"
  /** Pidfile is live but the secret file is missing — mid-spawn, or corrupt. */
  | "no-secret"
  /** Pidfile is live and the socket refused us — handoff window, or backlog. */
  | "unreachable";

export interface ConnectDecision {
  /** Delete pidfile/secret and unlink the socket. Only ever safe when dead. */
  reap: boolean;
  /** Wait and try connecting again — something live is probably there. */
  retry: boolean;
  /** Take the spawn lock and start a daemon. */
  spawn: boolean;
}

export function decideAfterConnectFailure(f: ConnectFailure): ConnectDecision {
  switch (f) {
    case "no-pidfile":
      // Nothing to reap and nothing to wait for.
      return { reap: false, retry: false, spawn: true };

    case "dead-process":
      // The one case where reaping is correct: the pid is gone, so the pidfile,
      // secret and socket are all leftovers from a crash.
      return { reap: true, retry: false, spawn: true };

    case "no-secret":
      // A live pid without a secret is a daemon still writing its files. Give
      // it a moment rather than reaping a daemon that is starting up.
      return { reap: false, retry: true, spawn: false };

    case "unreachable":
      // The dangerous one. A live pid that refused the connection is far more
      // likely mid-handoff or backlogged than broken, and its files belong to a
      // running process holding real sessions. Never reap; wait it out.
      return { reap: false, retry: true, spawn: false };
  }
}


// ── Authoritative liveness, via `loomptyd --probe` ───────────────────────────
//
// The pidfile flock is the daemon's single source of truth for who owns a
// socket path, and it is correct exactly where pid+connect misleads: the
// pidfile fd rides SCM_RIGHTS across a handoff, so the lock is held
// continuously by whichever daemon owns the path. There is no instant where it
// is unheld — the successor already holds it before the predecessor lets go.
//
// We shell out rather than declaring the C ABI through koffi on purpose. A
// hand-written signature that gets an enum value or an int width wrong fails in
// the one direction that destroys state — misreading LIVE as NONE and reaping a
// healthy daemon. The subcommand keeps one source of truth for that mapping,
// inside the layer that owns the lock.

export type DaemonState =
  | "live"
  | "none"
  | "unknown"
  /**
   * The daemon binary predates --probe (loomptyd < 0.4.6). Distinct from
   * "unknown": there is no answer to be had, so the probe must be sat out
   * entirely rather than treated as a refusal.
   *
   * Collapsing this into "unknown" is a total outage, not a safe default —
   * "never reap" also means "never spawn", so an extension shipping an older
   * vendored daemon would refuse to start one at all and lose PTY persistence
   * completely. Safe-by-default has to mean safe for the operation being
   * gated, and for spawn the dangerous act is spawning a RIVAL, not spawning.
   */
  | "unsupported";

/**
 * Map `loomptyd --probe` exit codes.
 *
 * The codes are deliberately NOT 0-is-success. Only 3 ("none") authorises
 * destroying anything, so every unanticipated outcome — a missing binary (127),
 * a crash (139), a bad path, a timeout — fails safe by construction rather than
 * by us remembering to check for it.
 */
export function daemonStateFromProbeExit(code: number | null): DaemonState {
  switch (code) {
    case 0:
      return "live";
    case 3:
      return "none";
    case 1:
      // Not in loomptyd's contract (0/2/3/4), and what its arg parser returns
      // for `unknown option: --probe`. Treat as "this binary cannot answer".
      return "unsupported";
    default:
      // 4 (explicit unknown), 2 (usage), and every unexpected code alike.
      return "unknown";
  }
}

/** Only a definitive "nothing owns this pidfile" permits a reap. */
export function probePermitsReap(state: DaemonState): boolean {
  return state === "none";
}
