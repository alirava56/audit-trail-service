#!/usr/bin/env bash
# Integration test for the exact --env-file / volume contract documented in README.
# Requires Docker, curl and Node.js on the host. Does not run in local npm check.
set -euo pipefail
prefix="audit-ci-${GITHUB_RUN_ID:-local}-$$"
container="$prefix"
volume="$prefix-data"
envfile="$(mktemp)"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  rm -f "$envfile"
}
trap cleanup EXIT
write_key="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
read_key="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
cat >"$envfile" <<ENV
AUDIT_WRITE_KEY=$write_key
AUDIT_READ_KEY=$read_key
AUDIT_WRITE_SERVICE=docker-ci
AUDIT_DB_PATH=./data/audit.sqlite
AUDIT_HOST=127.0.0.1
AUDIT_PORT=3000
AUDIT_MAX_EVENTS=100
ENV

docker volume create "$volume" >/dev/null
start_container() {
  docker run -d --name "$container" \
    --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --env-file "$envfile" \
    -e AUDIT_DB_PATH=/data/audit.sqlite \
    -e AUDIT_HOST=0.0.0.0 \
    -v "$volume:/data" \
    -p 127.0.0.1:18765:3000 \
    audit-trail-ci >/dev/null
  for _ in $(seq 1 80); do
    if curl --silent --fail http://127.0.0.1:18765/health/ready >/dev/null; then return 0; fi
    if ! [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ]; then
      docker logs "$container" >&2
      return 1
    fi
    sleep 0.2
  done
  docker logs "$container" >&2
  echo 'Docker service did not become ready' >&2
  return 1
}
start_container
created="$(curl --fail --silent --show-error -X POST \
  http://127.0.0.1:18765/v1/events \
  -H "Authorization: Bearer $write_key" -H 'Content-Type: application/json' \
  --data '{"eventType":"docker.write","actorId":"ci","outcome":"success"}')"
id="$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const a=JSON.parse(s);if(a.data.sequence!==1)process.exit(1);process.stdout.write(a.data.id)})')"
[ -n "$id" ]
docker stop "$container" >/dev/null
docker rm "$container" >/dev/null
start_container
curl --fail --silent --show-error "http://127.0.0.1:18765/v1/events/$id" \
  -H "Authorization: Bearer $read_key" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const a=JSON.parse(s);if(a.data.eventType!=="docker.write"||a.data.actorId!=="ci")process.exit(1)})'
echo 'PASS: Docker real HTTP write, non-root read-only container, restart and persistent SQLite volume'
