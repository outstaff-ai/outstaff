#!/usr/bin/env bash
# Brings up the office, Postgres and one agent from compose.yaml with dummy secrets, and checks that
# the office is healthy and the agent connects to it. Nothing here reaches a real service.
#   examples/compose/smoke.sh     (builds the images from the repository; SMOKE_PREBUILT=1 uses outstaff/{office,agent}:local)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
chmod 755 "$work"
export COMPOSE_PROJECT_NAME="ost-compose-smoke-$$"
export POSTGRES_PASSWORD=smoke
export OUTSTAFF_TEAM_DIR="$work/team"
export SECRETS_DIR="$work/secrets"
compose() { docker compose -f "$here/compose.yaml" -f "$work/override.yaml" "$@"; }
fail() { echo "FAIL: $*" >&2; compose logs --no-color >&2 || true; exit 1; }
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# The team schema of some releases requires a chat integration, and the office of those releases reads
# SLACK_BOT_TOKEN and SLACK_APP_TOKEN at start. Dummy files for both names keep the smoke
# independent of which release it runs on; releases that read only SLACK_OFFICE_BOT_TOKEN ignore them.
cat >"$work/override.yaml" <<'YAML'
services:
  office:
    secrets:
      - { source: smoke_SLACK_BOT_TOKEN, target: /run/secrets/outstaff/SLACK_BOT_TOKEN }
      - { source: smoke_SLACK_APP_TOKEN, target: /run/secrets/outstaff/SLACK_APP_TOKEN }
secrets:
  smoke_SLACK_BOT_TOKEN:
    file: ${SECRETS_DIR}/office/SLACK_BOT_TOKEN
  smoke_SLACK_APP_TOKEN:
    file: ${SECRETS_DIR}/office/SLACK_APP_TOKEN
YAML

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

compose up -d --no-deps sam
connected=""
for _ in $(seq 1 30); do
  if compose logs --no-color office 2>&1 | grep -q '"agent connected","person":"sam"'; then connected=yes; break; fi
  [ "$(compose ps --status running --services | grep -cx sam)" = 1 ] || break
  sleep 2
done
[ -n "$connected" ] || fail "the agent never showed up in the office log"
echo "ok   sam: connected to the office"
echo "smoke: all passed"
