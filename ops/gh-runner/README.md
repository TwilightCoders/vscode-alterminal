# CI runner for november (pointer)

november's self-hosted GitHub Actions runner is no longer the single-repo
container that used to live in this directory. It moved to **gh-run-club** — one
container running one repo-scoped agent per repo:

- **Public project:** https://github.com/TwilightCoders/gh-run-club
- **Deployed on november:** `/mnt/tank1/apps/gh-run-club/`. Token-only
  registration (no PAT); each agent's credentials persist in a Docker volume,
  so restarts/reboots reattach without re-registering.
- **Heavy CI deps are baked locally:** xvfb + Electron runtime libs (for
  `@vscode/test-electron`) and `cmake`/`libuv`/`build-essential` (for
  `loomptyd`) come from november's local `Dockerfile.runner` overlay on top of
  the lean gh-run-club base — the public image stays lean.

A repo targets it with `runs-on: self-hosted` (labels:
`self-hosted, linux, x64, november`). See this repo's `.github/workflows/ci.yml`.

> The previous repo-scoped single-runner setup (the `Dockerfile`,
> `docker-compose.yml`, and `.env.example` that used to be here) was retired on
> 2026-06-13 when november moved to gh-run-club. Its history is in git.
