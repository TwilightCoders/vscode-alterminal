/**
 * alterminald — Alterminal PTY daemon
 *
 * Standalone daemon binary built on libloom. Spawned by the Alterminal
 * VS Code extension to manage PTY sessions that survive extension host
 * reloads.
 *
 * Usage:
 *   alterminald --socket PATH --secret TOKEN [OPTIONS]
 *
 * Required:
 *   --socket PATH       Unix domain socket path for IPC
 *   --secret TOKEN      Shared secret for client authentication
 *
 * Optional:
 *   --lockfile PATH     Lockfile path (default: auto-derived from socket)
 *   --log PATH          Log file path (default: stderr)
 *   --scrollback N      Scrollback capacity per session (default: 10000)
 *   --foreground        Run in foreground (don't daemonize)
 *   --handoff-fd N      Receive handoff from this fd before running
 *   --version           Print version and exit
 *   --help              Print usage and exit
 */

#include <loom/loom.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

static const char* VERSION = "0.1.0";

static void usage(const char* argv0) {
    fprintf(stderr,
        "Usage: %s --socket PATH --secret TOKEN [OPTIONS]\n"
        "\n"
        "Required:\n"
        "  --socket PATH       Unix domain socket for IPC\n"
        "  --secret TOKEN      Shared secret for client auth\n"
        "\n"
        "Optional:\n"
        "  --lockfile PATH     Lockfile path (default: auto-derived)\n"
        "  --log PATH          Log file path (default: stderr)\n"
        "  --scrollback N      Scrollback capacity (default: 10000)\n"
        "  --foreground        Run in foreground\n"
        "  --handoff-fd N      Receive handoff from fd N\n"
        "  --version           Print version and exit\n"
        "  --help              Print this message and exit\n",
        argv0);
}

int main(int argc, char* argv[]) {
    const char* socket_path   = nullptr;
    const char* secret        = nullptr;
    const char* lockfile_path = nullptr;
    const char* log_path      = nullptr;
    size_t      scrollback    = 10000;
    int         foreground    = 0;
    int         handoff_fd    = -1;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            usage(argv[0]);
            return 0;
        }
        if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-v") == 0) {
            printf("alterminald %s (libloom)\n", VERSION);
            return 0;
        }
        if (strcmp(argv[i], "--foreground") == 0) {
            foreground = 1;
            continue;
        }

        // All remaining flags require a value
        if (i + 1 >= argc) {
            fprintf(stderr, "error: %s requires a value\n", argv[i]);
            return 1;
        }

        if (strcmp(argv[i], "--socket") == 0) {
            socket_path = argv[++i];
        } else if (strcmp(argv[i], "--secret") == 0) {
            secret = argv[++i];
        } else if (strcmp(argv[i], "--lockfile") == 0) {
            lockfile_path = argv[++i];
        } else if (strcmp(argv[i], "--log") == 0) {
            log_path = argv[++i];
        } else if (strcmp(argv[i], "--scrollback") == 0) {
            scrollback = static_cast<size_t>(atol(argv[++i]));
        } else if (strcmp(argv[i], "--handoff-fd") == 0) {
            handoff_fd = atoi(argv[++i]);
        } else {
            fprintf(stderr, "error: unknown option: %s\n", argv[i]);
            usage(argv[0]);
            return 1;
        }
    }

    if (!socket_path) {
        fprintf(stderr, "error: --socket is required\n");
        usage(argv[0]);
        return 1;
    }
    if (!secret) {
        fprintf(stderr, "error: --secret is required\n");
        usage(argv[0]);
        return 1;
    }

    loom_launch_opts opts = {};
    opts.socket_path   = socket_path;
    opts.ws_port       = 0;
    opts.ws_token      = secret;
    opts.log_path      = log_path;
    opts.scrollback    = scrollback;
    opts.pid_file      = nullptr;
    opts.lockfile_path = lockfile_path;
    opts.foreground    = foreground;
    opts.handoff_fd    = handoff_fd;

    pid_t pid = loom_daemon_launch(&opts);

    if (foreground) {
        // loom_daemon_launch blocks in foreground mode, returns 0 on clean exit
        return (pid == 0) ? 0 : 1;
    }

    if (pid <= 0) {
        fprintf(stderr, "error: daemon launch failed: %s\n",
                loom_last_error());
        return 1;
    }

    // Parent: daemon is running, print PID for the caller
    printf("%d\n", pid);
    return 0;
}
