#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
for cmd in docker zip sha256sum; do command -v "$cmd" >/dev/null || { echo "Required: $cmd" >&2; exit 1; }; done
docker info >/dev/null
platform="${PLATFORM:-linux/amd64}"
version="$(node -p "require('./package.json').version")"
image="simply-bridge:${version}"
current="simply-bridge:current"
release_dir="$(mktemp -d "$PWD/bridge-release-XXXXXX")"
docker build --platform "$platform" --build-arg "NODE_IMAGE=${NODE_IMAGE:-node:22-bookworm-slim}" -t "$image" .
# Tests run inside the image runtime, without internet and without user data.
docker run --rm --network none --entrypoint node --tmpfs /work:uid=1000,gid=1000 -v "$PWD/test:/app/test:ro" "$image" --test --test-concurrency=1 '/app/test/*.test.mjs'
docker tag "$image" "$current"
docker image save -o "$release_dir/simply-bridge-update.tar" "$image" "$current"
docker image inspect "$image" > "$release_dir/image-info.json"
printf '%s\n' "$platform" > "$release_dir/platform.txt"
cp deploy/compose.yaml deploy/compose-ca.yaml deploy/.env.example deploy/install-offline.sh deploy/DEPLOY.md deploy/UPDATE-PODMAN.txt "$release_dir/"
(cd "$release_dir" && sha256sum simply-bridge-update.tar image-info.json platform.txt compose.yaml compose-ca.yaml .env.example install-offline.sh DEPLOY.md UPDATE-PODMAN.txt > SHA256SUMS && zip -q simply-bridge-offline.zip simply-bridge-update.tar image-info.json platform.txt compose.yaml compose-ca.yaml .env.example install-offline.sh DEPLOY.md UPDATE-PODMAN.txt SHA256SUMS && zip -q simply-bridge-update.zip simply-bridge-update.tar UPDATE-PODMAN.txt)
printf 'Offline bundle: %s/simply-bridge-offline.zip\n' "$release_dir"
