# Self-hosted CI runner (november)

A self-hosted GitHub Actions runner for `TwilightCoders/vscode-alterminal`,
so private-repo CI — especially the heavy `daemon-tests` job (compiles
loomptyd + runs an Electron/xvfb VS Code test host) — runs on the NAS for
free instead of burning GitHub's private-repo minutes.

- **Host:** november (TrueNAS SCALE, Docker-native), `/mnt/tank1/apps/gh-runner/`
- **Labels:** `self-hosted, linux, x64, november`
- **Security:** private repo only. A self-hosted runner on a *public* repo
  lets fork PRs execute arbitrary code on the LAN — do not enable for
  untrusted fork PRs. No docker socket is mounted; the runner is unprivileged.

## Deploy / update

```sh
# from this repo:
git archive HEAD ops/gh-runner | ssh november 'mkdir -p /mnt/tank1/apps/gh-runner && tar -x --strip-components=2 -C /mnt/tank1/apps/gh-runner'
# create the token file (once):
TOKEN=$(gh api -X POST repos/TwilightCoders/vscode-alterminal/actions/runners/registration-token --jq .token)
ssh november "umask 077; printf 'RUNNER_TOKEN=%s\n' '$TOKEN' > /mnt/tank1/apps/gh-runner/.env"
# build + start:
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose up -d --build'
```

Verify: `gh api repos/TwilightCoders/vscode-alterminal/actions/runners --jq '.runners[]|{name,status}'`
should show `november: online`.

## Operate

```sh
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose logs -f'      # tail
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose restart'      # restart (config persists)
ssh november 'cd /mnt/tank1/apps/gh-runner && docker compose up -d --build' # rebuild image
```

For restart-across-recreate resilience without re-minting a token, switch
`.env` from `RUNNER_TOKEN` to a fine-grained `ACCESS_TOKEN` (see `.env.example`).

## Notes
- `daemon-tests` also needs a `LOOMPTY_TOKEN` repo secret (read access to the
  private `TwilightCoders/loompty` repo) to check out + build loomptyd.
- If the runner is offline, `runs-on: self-hosted` jobs queue until it's back.
