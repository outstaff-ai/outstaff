---
title: Container images
description: What the agent and office images contain, how tools get into an agent, how to extend an image, and how everything in them is pinned.
---

Outstaff publishes two images to `ghcr.io/outstaff-ai`, for `linux/amd64` and `linux/arm64`. There is one Dockerfile, `images/Dockerfile`, with one target per image. Both targets share the builder stage and the pinned base. The office image contains only Node, tini, CA certificates, git (for `OUTSTAFF_TEAM_REPO`) and the office bundle: no mise, `gh` or Claude Code. Agents use `ost pr` for pull requests, so no GitHub CLI is shipped. Each release tag `vX.Y.Z` publishes `:X.Y.Z` of both; `:latest` moves only for releases without a prerelease part. Pin the version in your own setup.

| Image                        | Run as            | Contains                                                                                                               |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ghcr.io/outstaff-ai/office` | `outstaff-office` | Node, tini, CA certificates, git (to read a team config from a repository) and the office bundle. Health on port 8081. |
| `ghcr.io/outstaff-ai/agent`  | `ost-agent`       | The agent, the `ost` CLI, the stock catalog, git, [mise](https://mise.jdx.dev) and the Claude Code binary.             |

## Tools come from the toolsets

The `agent` image is small on purpose. The language toolchains and CLIs a role needs (Node package managers, Python, Go, `kubectl` and so on) are declared in the toolsets and `team.yaml`, and the agent installs them with mise when it starts ([#156](https://github.com/outstaff-ai/outstaff/issues/156)). mise keeps its installs in `MISE_DATA_DIR` and `MISE_CACHE_DIR` below the agent's home, so the home volume keeps them between restarts and a restart does not download them again.

If you want instant starts, or a machine without outbound access to the tool hosts, build an image `FROM` the agent image with the tools already installed (see below). The agent finds them on `PATH` and has nothing left to install.

## The container contract

- **Non-root.** All images run as user `outstaff` (uid 10001) and use [tini](https://github.com/krallin/tini) as init.
- **Read-only root filesystem.** Run with `--read-only` (or `readOnlyRootFilesystem: true`) and give the containers writable places:
  - the agent: `/home/outstaff` (its `HOME`: worktrees, sessions, journal, memory) and `/tmp`;
  - the office: `/var/lib/outstaff` (the SQLite database, unless you use Postgres through `OUTSTAFF_STORE_URL`) and `/tmp`.
- **No secrets inside.** Secrets come from files under `/run/secrets/outstaff`, or from the environment as a fallback ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)).
- **Health.** The office image has a `HEALTHCHECK` that calls `/healthz` on `OUTSTAFF_HEALTH_PORT` (default 8081). Use `/readyz` for readiness. The agent has no port; it exits when the office rejects it, so let your platform restart it.
- **Versions.** `ost-agent --version`, `ost --version` and `outstaff-office --version` print the package version.

## Extending an image

The catalog is baked in ([0005](/decisions/0005-catalog-baked-and-ejectable/)), so a team that does not change it uses the images as they are. A team that ejects roles or skills, or needs more tools, builds its own image:

```dockerfile
FROM ghcr.io/outstaff-ai/agent:1.2.3

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make \
 && rm -rf /var/lib/apt/lists/*
USER outstaff

# The team's ejected catalog, validated and rendered at build time.
COPY --chown=outstaff:outstaff .outstaff /home/outstaff/.outstaff
RUN ost build
```

`ost build` validates and renders the ejected content so a typo fails the build, not a running agent. It arrives with the eject commands; until then the `COPY` is all an ejected team needs. Keep these rules in your own image:

- switch back to `USER outstaff` at the end;
- do not put secrets in `ARG`, `ENV` or a layer; use BuildKit `--secret` when a build step needs one;
- write only below `/home/outstaff` and `/tmp` at run time, so the image stays usable with a read-only root;
- pin what you add the same way (see below) and rebuild when a new Outstaff release comes out.

## Pinning policy

Everything in the images is pinned, so a tag always means the same bits:

- **Base image:** `node:24.22.1-slim` (Debian 12), by version and by the digest of its multi-arch index, matching the Node version the repository itself requires.
- **npm packages:** exact versions in every `package.json`, resolved through `pnpm-lock.yaml` (`--frozen-lockfile`). Only production dependencies reach the images: the builder stage runs `pnpm deploy --prod` per package.
- **Claude Code binary:** the Claude Agent SDK ships it as a platform package (`@anthropic-ai/claude-agent-sdk-linux-x64` or `-linux-arm64`, glibc). The SDK version is an exact pin and the lockfile holds the integrity hash of each platform package, so a release pins the Claude Code version too ([0009](/decisions/0009-agent-sdk-runtime/)). The agent build runs the binary with `--version` and fails if it is missing.
- **CLI tools** (`mise`): exact versions, downloaded from the vendor and verified against a sha256 per architecture in `images/Dockerfile`. A mismatch fails the build.
- **Debian packages** (git, tini, ca-certificates): taken from the pinned base image's Debian release at build time. They are not version-pinned individually; rebuild images for security updates.

To bump a tool, change the version and both checksums in the build arguments of `images/Dockerfile` together, taking the checksums from the vendor's published checksum file.

## Building and testing the images

From the repository root:

```sh
docker build -f images/Dockerfile --target agent -t outstaff/agent:dev .
docker build -f images/Dockerfile --target office -t outstaff/office:dev .
images/smoke.sh outstaff dev
```

`images/smoke.sh` starts each image with a read-only root, checks the version commands (including `mise --version`), and starts the office on SQLite with a minimal team file until its health check passes. The `Images` workflow does the same on every pull request that touches `images/` or `packages/`, for both architectures, and publishes on `v*` tags.
