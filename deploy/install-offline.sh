#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v docker >/dev/null
docker compose version >/dev/null
sha256sum --check SHA256SUMS
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo 'Created .env. Set PUBLIC_URL to the exact server address, then run this script again.'
  exit 0
fi
if grep -q 'YOUR-LINUX-SERVER' .env; then
  echo 'Set PUBLIC_URL in .env before starting.' >&2; exit 1
fi
docker load -i simply-bridge-image.tar
docker compose up -d --pull never --no-build
docker compose ps
echo 'Open the PUBLIC_URL configured in .env. View logs: docker compose logs --tail 100 bridge'
