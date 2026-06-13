# Self-hosted GitHub Actions runner for alterminal CI, tuned for the
# daemon-contract job (builds loomptyd + runs the @vscode/test-electron host).
#
# Base: myoung34/github-runner (standalone-compose-friendly runner) on Ubuntu
# 22.04 (jammy) — modern enough for the VS Code build the test host downloads,
# and avoids noble's libNAMEt64 package renames. (:latest is focal/20.04, too
# old for current VS Code.)
FROM myoung34/github-runner:ubuntu-jammy

# Extra deps NOT in the base image:
#   - loomptyd C++ build:           build-essential cmake pkg-config libuv1-dev
#   - node-pty / koffi native gyp:  python3 (g++/make come from build-essential)
#   - @vscode/test-electron host:   xvfb + Electron's shared libraries
# node itself is installed per-job by actions/setup-node, so it's not baked in.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config libuv1-dev python3 \
      xvfb xauth \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxshmfence1 libxkbcommon0 \
      libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 \
      libcups2 libatk1.0-0 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 \
      libatspi2.0-0 \
 && rm -rf /var/lib/apt/lists/*
