# syntax=docker/dockerfile:1.24

# One file, one target per image: agent, office. The agent-e2e and e2e-stubs targets are for the end-to-end test only (e2e/) and are never published. Tools beyond these come from the toolsets at start (mise).
# Build from the repository root:  docker build -f images/Dockerfile --target agent .
#
# Every input is pinned: the base image by version and digest, tools by version and sha256,
# npm packages by the lockfile (which also pins the Claude Code binary, see the agent stage).
# OUTSTAFF_VERSION is not a build input but metadata: the release version the processes report (a release tag builds the
# images without bumping package.json). The release workflow passes it; empty, they report their package's version.

# node:24.22.1-slim (Debian 12), multi-arch index digest.
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# ---------------------------------------------------------------- builder
FROM ${NODE_IMAGE} AS builder
ARG PNPM_VERSION=12.9.1
RUN npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY . .
# Production dependencies only: `pnpm deploy --prod` copies each package with just what it needs.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
 && pnpm --filter outstaff... --filter @outstaff/office... run build \
 && pnpm --filter outstaff deploy --prod /out/cli \
 && pnpm --filter @outstaff/office deploy --prod /out/office

# ---------------------------------------------------------------- fetch
# Downloads and verifies the pinned CLI tools (mise). Nothing from this stage but the binaries ships.
FROM ${NODE_IMAGE} AS fetch
ARG TARGETARCH
ARG MISE_VERSION=2026.10.18
ARG MISE_SHA256_AMD64=e97c38973336aa2ff350fea50f47b412b266fe263b102b7200ff1e9b118c6942
ARG MISE_SHA256_ARM64=3a3c72376687ba21a588d0f5a2c88c76f483fb6cdece7b0fc43d5e3132b08a52
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN set -eu; \
    pick() { case "${TARGETARCH}" in amd64) echo "$1" ;; arm64) echo "$2" ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac; }; \
    get() { curl -fsSL --retry 3 -o "$1" "$2"; echo "$3  $1" | sha256sum -c -; }; \
    mkdir -p /out/bin; \
    get mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-$(pick x64 arm64)" "$(pick "${MISE_SHA256_AMD64}" "${MISE_SHA256_ARM64}")"; \
    install -m 0755 mise /out/bin/mise; \
    chmod 0755 /out/bin/*

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ARG UID=10001
LABEL org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/outstaff-ai/outstaff"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid ${UID} outstaff \
 && useradd --uid ${UID} --gid ${UID} --home-dir /home/outstaff --create-home --shell /bin/bash outstaff \
 && mkdir -p /var/lib/outstaff \
 && chown outstaff:outstaff /var/lib/outstaff
ENV NODE_ENV=production \
    HOME=/home/outstaff
WORKDIR /home/outstaff
COPY LICENSE NOTICE /usr/share/doc/outstaff/
ENTRYPOINT ["/usr/bin/tini", "--"]

# ---------------------------------------------------------------- agent
FROM base AS agent
ARG BUBBLEWRAP_VERSION=0.8.0-2+deb12u1
# The runtime adapters this image carries, space-separated; a person's runtime (people[].runtime, else
# integrations.runtime) must be one of them. `ost-agent --runtimes` prints the same list, and the smoke test compares them.
LABEL work.outstaff.runtimes="claude-agent-sdk"
ARG SOCAT_VERSION=1.7.4.4-2
ARG CURL_VERSION=7.88.1-10+deb12u15
# What a headless Chromium needs to run, but no browser: a repository's own Playwright downloads the browser it pins
# (`npx playwright install chromium`, without --with-deps, which needs root). These are the shared libraries of
# Playwright's install-deps for chromium and chromium-headless-shell on Debian 12 (playwright-core 1.64.1, nativeDeps,
# the same list on amd64 and arm64), its fontconfig and freetype, and fonts for Latin text (Liberation), symbols
# (DejaVu) and emoji (Noto Color Emoji). Each version is the same on both architectures.
ARG BROWSER_PACKAGES="\
libasound2=1.2.8-1+b1 \
libatk-bridge2.0-0=2.46.0-5 \
libatk1.0-0=2.46.0-5 \
libatspi2.0-0=2.46.0-5 \
libcairo2=1.16.0-7 \
libcups2=2.4.2-3+deb12u9 \
libdbus-1-3=1.14.10-1~deb12u1 \
libdrm2=2.4.114-1+b1 \
libgbm1=22.3.6-1+deb12u2 \
libglib2.0-0=2.74.6-2+deb12u9 \
libnspr4=2:4.35-1 \
libnss3=2:3.87.1-1+deb12u4 \
libpango-1.0-0=1.50.12+ds-1 \
libx11-6=2:1.8.4-2+deb12u2 \
libxcb1=1.15-1 \
libxcomposite1=1:0.4.5-1 \
libxdamage1=1:1.1.6-1 \
libxext6=2:1.3.4-1+b1 \
libxfixes3=1:6.0.0-2 \
libxkbcommon0=1.5.0-1 \
libxrandr2=2:1.5.2-2+b1 \
libfontconfig1=2.14.1-4 \
libfreetype6=2.12.1+dfsg-5+deb12u4 \
fonts-liberation=1:1.07.4-11 \
fonts-dejavu-core=2.37-6 \
fonts-noto-color-emoji=2.042-0+deb12u1"
# Claude Code runs each of the agent's commands in a bubblewrap sandbox (user and PID namespaces, a fresh /proc) so
# they cannot read its credential; it needs socat for that sandbox too. bwrap must not be setuid: it works through an
# unprivileged user namespace, which the container's seccomp and AppArmor profiles allow (examples/k8s).
# curl is for the agent's own commands (runbooks, health checks, APIs); what it reaches is the network policy's call.
RUN apt-get update \
 && apt-get install -y --no-install-recommends "bubblewrap=${BUBBLEWRAP_VERSION}" "socat=${SOCAT_VERSION}" \
      "curl=${CURL_VERSION}" ${BROWSER_PACKAGES} \
 && rm -rf /var/lib/apt/lists/* \
 && test ! -u /usr/bin/bwrap
# mise installs the tools a team's toolsets ask for at agent start; keep its data on the home volume.
ENV MISE_DATA_DIR=/home/outstaff/.local/share/mise \
    MISE_CACHE_DIR=/home/outstaff/.cache/mise \
    PATH=/home/outstaff/.local/share/mise/shims:$PATH
COPY --from=fetch /out/bin/mise /usr/local/bin/
COPY --from=builder /out/cli /opt/outstaff
# The Claude Code binary is the SDK's platform package (linux glibc, x64 or arm64). Its version is
# pinned by the exact SDK version in package.json and the lockfile integrity; the build fails if it
# is missing or does not run.
RUN chmod 0755 /opt/outstaff/dist/cli.js \
 && ln -s /opt/outstaff/node_modules/.bin/ost-agent /usr/local/bin/ost-agent \
 && ln -s /opt/outstaff/dist/cli.js /usr/local/bin/ost \
 && ln -s /opt/outstaff/dist/cli.js /usr/local/bin/outstaff \
 && claude="$(ls /opt/outstaff/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude)" \
 && "$claude" --version
ARG OUTSTAFF_VERSION=
ENV OUTSTAFF_VERSION=${OUTSTAFF_VERSION}
USER outstaff
VOLUME ["/home/outstaff", "/tmp"]
CMD ["ost-agent"]

# ---------------------------------------------------------------- office
FROM base AS office
COPY --from=builder /out/office /opt/outstaff
RUN ln -s /opt/outstaff/dist/main.js /usr/local/bin/outstaff-office \
 && chmod 0755 /opt/outstaff/dist/main.js
ARG OUTSTAFF_VERSION=
USER outstaff
ENV OUTSTAFF_STORE_URL=sqlite:///var/lib/outstaff/office.db \
    OUTSTAFF_HEALTH_PORT=8081 \
    OUTSTAFF_VERSION=${OUTSTAFF_VERSION}
EXPOSE 8080 8081 8082
VOLUME ["/var/lib/outstaff", "/tmp"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.OUTSTAFF_HEALTH_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["outstaff-office"]

# ---------------------------------------------------------------- end-to-end test only (e2e/), never published
# The agent with the scripted runtime (a fixed script of tool calls instead of a model) added next to it.
FROM builder AS builder-e2e
RUN pnpm --filter @outstaff/runtime-scripted... run build \
 && pnpm --filter @outstaff/runtime-scripted deploy --prod /out/e2e

FROM agent AS agent-e2e
# Its CMD, the e2e bin, carries the scripted runtime too; `ost-agent --runtimes` here still lists the agent's own.
LABEL work.outstaff.runtimes="claude-agent-sdk scripted"
COPY --from=builder-e2e /out/e2e /opt/outstaff-e2e
# The developer toolset's pnpm and the team's gh, installed now because the test downloads nothing at start. The agent
# still writes the global mise config at start, which is what makes the shims work in the worktree.
RUN mise install pnpm@12.9.1 gh@2.103.3
CMD ["node", "/opt/outstaff-e2e/dist/bin.js"]

# Stand-ins for GitHub (API and git remote) and the tracker, served by the shared vendor stand-ins (testing/*).
FROM builder AS builder-stubs
RUN pnpm --filter @outstaff/e2e-stubs... run build \
 && pnpm --filter @outstaff/e2e-stubs deploy --prod /out/stubs

# It binds port 443 for git, so it runs as root.
FROM base AS e2e-stubs
COPY --from=builder-stubs /out/stubs /opt/stubs
USER root
EXPOSE 443 8081
CMD ["node", "/opt/stubs/server.ts"]
