# Self-hosted CI runner (november)

A self-hosted GitHub Actions runner on november (TrueNAS) so private-repo CI
runs on the NAS for free instead of burning GitHub's private-repo minutes.
A repo uses it by adding `runs-on: self-hosted` to a job.

- **Host:** november (TrueNAS SCALE, Docker-native), `/mnt/tank1/apps/gh-runner/`
- **Scope:** **repo** (`TwilightCoders/vscode-alterminal`). ⚠️ Org scope was tried
  and **doesn't work**: the runner registered fine at org scope (Default group →
  All repositories, correct labels, Idle), but GitHub never dispatched this
  private repo's jobs to it — they queued indefinitely; switching back to repo
  scope ran the same jobs immediately. Likely a Free-org org-runner limitation
  (org self-hosted runners not serving private repos) or an org policy needing
  `admin:org` to inspect. For "any repo on the NAS": either run one runner
  container per repo (repo scope each), or resolve the org-dispatch issue first.
- **Labels:** `self-hosted, linux, x64, november`
- **Security:** private repos only. A self-hosted runner reachable by a *public*
  repo lets fork PRs run arbitrary code on the LAN — keep it off public/fork PRs.
  No docker socket is mounted; the runner is unprivileged.

## Deploy / update

```sh
# ship the config from this repo:
git archive HEAD ops/gh-runner | ssh november 'mkdir -p /mnt/tank1/apps/gh-runner && tar -x --strip-components=2 -C /mnt/tank1/apps/gh-runner'
# token (once): Org Settings → Actions → Runners → New runner copies an ORG
# registration token (short-lived ~1h). Or, with admin:org on gh:
#   gh api -X POST orgs/TwilightCoders/actions/runners/registration-token --jq .token
ssh november "umask 077; printf 'RUNNER_TOKEN=%s\n' '<ORG_TOKEN>' > /mnt/tank1/apps/gh-runner/.env"
# build + start:
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose up -d --build'
```

Verify (needs admin:org): `gh api orgs/TwilightCoders/actions/runners --jq '.runners[]|{name,status}'`
→ `november: online`. Without it, check `docker compose logs` for
"Listening for Jobs", or just push a CI run and watch the job land on it.

## Operate

```sh
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose logs -f'         # tail
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose restart'         # restart (config persists)
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose up -d --build'   # rebuild image
```

`RUNNER_TOKEN` survives `restart`/NAS reboot but not a full `down`+recreate
(single-use). For recreate-resilience swap it for an `ACCESS_TOKEN` PAT with org
"Self-hosted runners" read+write (see `.env.example`); the runner then
re-registers itself.

## Concurrency
One runner = one job at a time. For parallelism, scale replicas (needs an
`ACCESS_TOKEN` PAT so each replica self-registers):
`docker compose up -d --scale runner=N` (give each a unique `RUNNER_NAME` via an
ephemeral suffix, or set `EPHEMERAL=true`).

## Notes
- `daemon-tests` (alterminal) also needs a `LOOMPTY_TOKEN` repo secret (read on
  the private `TwilightCoders/loompty` repo) to check out + build loomptyd.
- If the runner is offline, `runs-on: self-hosted` jobs queue until it's back.
