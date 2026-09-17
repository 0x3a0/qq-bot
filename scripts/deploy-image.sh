#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
CONTAINER_NAME="qq-market-bot"
NETWORK_NAME="qq-market-network"
IMAGE_REF="${1:-${QQ_MARKET_BOT_IMAGE:-ghcr.io/0x3a0/qq-bot:latest}}"

require_configured_value() {
  local name="$1"
  if ! grep -Eq "^[[:space:]]*${name}=[^[:space:]#].*" "${ENV_FILE}"; then
    printf 'Missing required configuration: %s in %s\n' "${name}" "${ENV_FILE}" >&2
    exit 1
  fi
}

run_container() {
  local image="$1"
  docker run --detach \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --env-file "${ENV_FILE}" \
    --network "${NETWORK_NAME}" \
    "${image}"
}

restore_previous_container() {
  if [[ -z "${previous_image}" ]]; then
    return
  fi

  docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  printf 'Restoring the previous image.\n' >&2
  run_container "${previous_image}" >/dev/null
}

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker is required to deploy the bot.\n' >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'Missing deployment environment file: %s\n' "${ENV_FILE}" >&2
  exit 1
fi

require_configured_value ONEBOT_WS_URL
require_configured_value THS_API_KEY

if ! docker network inspect "${NETWORK_NAME}" >/dev/null; then
  printf 'Required Docker network does not exist: %s\n' "${NETWORK_NAME}" >&2
  exit 1
fi

previous_image=""
if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  previous_image="$(docker inspect --format '{{.Image}}' "${CONTAINER_NAME}")"
fi

docker pull "${IMAGE_REF}"

if [[ -n "${previous_image}" ]]; then
  docker rm --force "${CONTAINER_NAME}" >/dev/null
fi

if ! run_container "${IMAGE_REF}" >/dev/null; then
  printf 'New container could not be started.\n' >&2
  restore_previous_container
  exit 1
fi

sleep 5

if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}")" != "true" ]]; then
  printf 'New container exited during startup.\n' >&2
  docker logs --tail 100 "${CONTAINER_NAME}" >&2 || true
  docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  restore_previous_container
  exit 1
fi

docker inspect --format 'Deployment complete: {{.Config.Image}} ({{.State.Status}})' "${CONTAINER_NAME}"
