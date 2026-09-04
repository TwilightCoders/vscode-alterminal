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

