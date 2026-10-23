#!/usr/bin/env bash
# Starts each image and checks it does what it is for.
#   images/smoke.sh <repository-prefix> <tag> [image...]
# Example: images/smoke.sh ost dev agent office   (images default to all four)
# Images run with a read-only root filesystem and only /tmp and HOME writable, as the docs advise.
set -euo pipefail

prefix="${1:?usage: smoke.sh <repository-prefix> <tag> [image...]}"
tag="${2:?usage: smoke.sh <repository-prefix> <tag> [image...]}"
shift 2
images=("$@")
if [ "${#images[@]}" -eq 0 ]; then images=(agent office); fi

fail() { echo "FAIL: $*" >&2; exit 1; }
ref() { echo "${prefix}/$1:${tag}"; }

# Runs a command in an image with the hardened settings; prints its output.
run() {
  local image="$1"; shift
  docker run --rm --read-only --tmpfs /tmp --tmpfs /home/outstaff:uid=10001,gid=10001 \
    --cap-drop ALL --security-opt no-new-privileges "$(ref "$image")" "$@"
}

expect() { # expect <image> <pattern> <command...>
  local image="$1" pattern="$2"; shift 2
  local out
  out="$(run "$image" "$@" 2>&1)" || fail "$image: '$*' exited non-zero: $out"
  grep -Eq "$pattern" <<<"$out" || fail "$image: '$*' printed '$out', expected /$pattern/"
  echo "ok   $image: $*"
}

smoke_agent() {
  local image="$1"
  expect "$image" '^[0-9]+\.[0-9]+\.[0-9]+' ost-agent --version
  expect "$image" '^[0-9]+\.[0-9]+\.[0-9]+' ost --version
  expect "$image" '^[1-9][0-9]*$' id -u
  expect "$image" 'git version' git --version
  expect "$image" '^20[0-9]{2}\.' mise --version
  # The pinned Claude Code binary the SDK launches.
  expect "$image" 'Claude Code' sh -c 'exec /opt/outstaff/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude --version'
}

smoke_office() {
  local image=office name="ost-smoke-office-$$" dir
  expect "$image" '^[0-9]+\.[0-9]+\.[0-9]+' outstaff-office --version
  # The office carries no agent tooling.
  expect "$image" '^none$' sh -c 'for c in mise gh claude; do command -v "$c" >/dev/null && { echo "$c on PATH"; exit 1; }; done; echo none'

  dir="$(mktemp -d)"
  chmod 755 "$dir"
  cat >"$dir/team.yaml" <<'YAML'
version: 1
team: { name: acme }
catalog: { version: 0.0.0 }
repos:
  - { name: app, url: git.acme.example/acme/app, kind: primary }
people:
  - { handle: sam, name: Sam, role: developer }
integrations:
  chat: { adapter: slack }
  vcs: { adapter: github }
  runtime: { adapter: claude-agent-sdk }
  tracker: { adapter: itsaplan, url: "https://tracker.acme.example", project: SHOP }
YAML
  chmod 644 "$dir/team.yaml"
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' RETURN

  docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges \
    -v "$dir:/team:ro" -v ost-smoke-data:/var/lib/outstaff \
    -e OUTSTAFF_TEAM_FILE=/team/team.yaml -e OUTSTAFF_AGENT_TOKEN_SAM=smoke -e ITSAPLAN_API_KEY=smoke -e SLACK_OFFICE_BOT_TOKEN=xoxb-smoke \
    -e GH_OFFICE_APP_ID=1 -e GH_OFFICE_APP_INSTALLATION_ID=1 -e GH_OFFICE_APP_SLUG=acme-office \
    "$(ref "$image")" >/dev/null

  # The image's own HEALTHCHECK (/healthz) decides; give the office up to 60 seconds.
  local status=""
  for _ in $(seq 1 30); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
    [ "$status" = healthy ] && break
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
    sleep 2
  done
  if [ "$status" != healthy ]; then
    docker logs "$name" >&2 || true
    docker volume rm -f ost-smoke-data >/dev/null 2>&1 || true
    fail "office: health is '$status', expected healthy"
  fi
  echo "ok   office: /healthz healthy with SQLite on a read-only root"
  docker rm -f "$name" >/dev/null
  docker volume rm -f ost-smoke-data >/dev/null 2>&1 || true
}

for image in "${images[@]}"; do
  case "$image" in
    agent) smoke_agent agent ;;
    office) smoke_office ;;
    *) fail "unknown image '$image'" ;;
  esac
done
echo "smoke: all passed"
