#!/usr/bin/env bash
# Container install smoke for the packaged gateway image (#504 Phase G).
#
# Extracted from lane-gateway-package.yml (#557): shell embedded in YAML cannot
# be run locally, shellcheck'd on the per-PR loop, or edited without risking the
# workflow parse. Everything here is plain bash driven by two env vars, so
# `IMAGE=centraid-gateway:dev RUN_ID=local bash scripts/gateway-package/container-smoke.sh`
# reproduces CI exactly.
#
# Proves three things about the shipped image, as an external observer:
#   1. the container boots and answers the smoke probe over a published port;
#   2. it answers a *second* probe (first-boot side effects did not wedge it);
#   3. it actually persists under the mounted /data volume.
set -euo pipefail

: "${IMAGE:?IMAGE must name the built gateway image}"
: "${RUN_ID:?RUN_ID must be unique per run (github.run_id in CI)}"

PORT="${PORT:-18788}"
# A named volume lets the non-root uid 10001 in the image write without the
# host-bind ownership games a bind mount would need.
VOL="centraid-gw-smoke-${RUN_ID}"
CREDENTIAL_VOL="centraid-gw-smoke-credentials-${RUN_ID}"
NAME="centraid-gw-smoke-${RUN_ID}"

docker volume rm "$VOL" 2>/dev/null || true
docker volume rm "$CREDENTIAL_VOL" 2>/dev/null || true
docker volume create "$VOL"
docker volume create "$CREDENTIAL_VOL"
docker rm -f "$NAME" 2>/dev/null || true

cleanup() {
  docker logs "$NAME" 2>&1 || true
  docker rm -f "$NAME" 2>/dev/null || true
  docker volume rm "$VOL" 2>/dev/null || true
  docker volume rm "$CREDENTIAL_VOL" 2>/dev/null || true
}
# Registered before `docker run` so a failure to start still dumps logs.
trap cleanup EXIT

docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:8787" \
  -v "${VOL}:/data" \
  -v "${CREDENTIAL_VOL}:/config" \
  "$IMAGE"

node scripts/gateway-package/smoke.mjs --base-url "http://127.0.0.1:${PORT}"
# Second probe for consistency (external observer).
node scripts/gateway-package/smoke.mjs --base-url "http://127.0.0.1:${PORT}"

# Prove the durable mount: the volume has content after boot.
FILES="$(docker run --rm -v "${VOL}:/data" busybox ls -A /data 2>/dev/null || true)"
if [ -z "$FILES" ]; then
  echo "expected gateway to write under mounted /data" >&2
  exit 1
fi
CREDENTIAL_FILES="$(
  docker run --rm -v "${CREDENTIAL_VOL}:/config" busybox find /config -type f -print 2>/dev/null ||
    true
)"
if [ -z "$CREDENTIAL_FILES" ]; then
  echo "expected gateway to persist its external wrapping credential under /config" >&2
  exit 1
fi
echo "container data mount OK: $FILES"
echo "container custody mount OK"
