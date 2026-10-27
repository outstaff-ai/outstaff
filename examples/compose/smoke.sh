#!/usr/bin/env bash
# Brings up the office, Postgres and one agent from compose.yaml with dummy secrets, and checks that
# the office is healthy and the agent connects to it, then starts the agent again with the optional subprocess
# sandbox (compose.sandbox.yaml, sandbox: bubblewrap) and checks it too. Nothing here reaches a real service.
#   examples/compose/smoke.sh     (builds the images from the repository; SMOKE_PREBUILT=1 uses outstaff/{office,agent}:local)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
chmod 755 "$work"
export COMPOSE_PROJECT_NAME="ost-compose-smoke-$$"
export POSTGRES_PASSWORD=smoke
export OUTSTAFF_TEAM_DIR="$work/team"
export SECRETS_DIR="$work/secrets"
files=(-f "$here/compose.yaml")
compose() { docker compose "${files[@]}" "$@"; }
fail() { echo "FAIL: $*" >&2; compose logs --no-color >&2 || true; exit 1; }
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# A one-person team: acme's shape, but only the adapters the smoke can start without a network.
mkdir -p "$work/team"
cat >"$work/team/team.yaml" <<'YAML'
version: 1
team: { name: acme }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.com/acme-example/shop, kind: primary }
people:
  - { handle: sam, name: Sam Duarte, role: developer, identities: { vcs: "acme-sam[bot]" }, repos: { shop: write } }
integrations:
  chat: { adapter: slack }
  vcs: { adapter: github }
  runtime: { adapter: claude-agent-sdk }
  tracker: { adapter: itsaplan, url: "https://tracker.acme.example", project: SHOP }
YAML
chmod 644 "$work/team/team.yaml"

# Dummy secret files for every name compose.yaml mounts, readable by the image's user (uid 10001).
compose config --format json | node -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const s of Object.values(c.secrets)) console.log(s.file);' |
  while read -r f; do
    mkdir -p "$(dirname "$f")"
    echo "dummy-$(basename "$f")" >"$f"
    chmod 644 "$f"
  done

# SMOKE_PREBUILT=1: use the images that are already tagged (CI builds them with a layer cache).
build=(--build); [ "${SMOKE_PREBUILT:-}" = 1 ] && build=()
compose up -d "${build[@]}" --wait --wait-timeout 180 postgres office || fail "office did not become healthy"
echo "ok   office: healthy with Postgres on a read-only root"

# Waits until the office logs that sam connected for the <n>th time, or sam stops.
await_sam() {
  local n="$1"
  for _ in $(seq 1 45); do
    [ "$(compose logs --no-color office 2>&1 | grep -c '"agent connected","person":"sam"')" -ge "$n" ] && return 0
    [ "$(compose ps --status running --services | grep -cx sam)" = 1 ] || return 1
    sleep 2
  done
  return 1
}

compose up -d --no-deps sam
await_sam 1 || fail "the agent never showed up in the office log"
echo "ok   sam: connected to the office"

# The optional subprocess sandbox. An AppArmor host (Ubuntu, Debian) needs the agents' profile loaded first.
if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then
  if ! sudo -n true 2>/dev/null; then
    echo "::notice::AppArmor is enforced here and loading the outstaff-agent profile needs sudo; the sandbox part of the smoke is skipped."
    echo "smoke: all passed (sandbox skipped)"
    exit 0
  fi

  sudo apparmor_parser -r -W "$here/apparmor/outstaff-agent" || fail "could not load the outstaff-agent AppArmor profile"
  echo "ok   host: outstaff-agent AppArmor profile loaded"
fi

sed -i.bak 's/runtime: { adapter: claude-agent-sdk }/runtime: { adapter: claude-agent-sdk, sandbox: bubblewrap }/' "$work/team/team.yaml"
grep -q 'sandbox: bubblewrap' "$work/team/team.yaml" || fail "could not turn the sandbox on in the smoke team"
files+=(-f "$here/compose.sandbox.yaml")
# Only the office reads the team file, so it restarts with the change; sam is recreated for the sandbox's container
# settings and takes the new team from the office. Its own log says when it connected with it.
compose up -d --no-deps --force-recreate --wait --wait-timeout 180 office || fail "the office did not come back healthy"
compose up -d --no-deps --force-recreate sam
for _ in $(seq 1 45); do
  compose logs --no-color sam 2>&1 | grep -q ' info connected$' && break
  [ "$(compose ps --status running --services | grep -cx sam)" = 1 ] || break
  sleep 2
done
compose logs --no-color sam 2>&1 | grep -q ' info connected$' || fail "the agent with sandbox: bubblewrap never connected"
echo "ok   sam: connected with sandbox: bubblewrap"

# The agent started, so the runtime's start-up probe passed; run it once more to show what it found.
probe="$(compose exec -T sam node --input-type=module -e '
  const m = await import("/opt/outstaff/node_modules/@outstaff/integration.runtime.claude/dist/index.js");
  const p = m.probeSubprocessSandbox();
  console.log(p.detail + (p.fix ? " Fix: " + p.fix : ""));
  process.exit(p.ok ? 0 : 1);' 2>&1)" || fail "subprocess sandbox: $probe"
echo "ok   sam: $probe"
echo "smoke: all passed"
