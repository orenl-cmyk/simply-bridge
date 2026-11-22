#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
for cmd in docker zip sha256sum curl; do command -v "$cmd" >/dev/null || { echo "Required: $cmd" >&2; exit 1; }; done
docker info >/dev/null
platform="${PLATFORM:-linux/amd64}"
version="$(node -p "require('./package.json').version")"
image="simply-bridge:${version}"
current="simply-bridge:current"
release_dir="$(mktemp -d "$PWD/bridge-release-XXXXXX")"
docker build --platform "$platform" --build-arg "NODE_IMAGE=${NODE_IMAGE:-node:22.23.5-bookworm-slim}" -t "$image" .
# Tests run inside the image runtime, without internet and without user data.
docker run --rm --network none --entrypoint node --tmpfs /work:uid=1000,gid=1000 -v "$PWD/test:/app/test:ro" "$image" --test --test-concurrency=1 '/app/test/*.test.mjs'

# Exercise the production container, healthcheck, persistent DATA_DIR and outbound DNS/HTTPS.
smoke_container="simply-bridge-smoke-${GITHUB_RUN_ID:-$$}"
smoke_volume="simply-bridge-smoke-data-${GITHUB_RUN_ID:-$$}"
cleanup_smoke(){ docker rm -f "$smoke_container" >/dev/null 2>&1 || true; docker volume rm "$smoke_volume" >/dev/null 2>&1 || true; }
trap cleanup_smoke EXIT
docker volume create "$smoke_volume" >/dev/null
run_smoke(){
 docker run -d --name "$smoke_container" --restart unless-stopped -p 127.0.0.1:4318:4318 \
  -e HOST=0.0.0.0 -e PORT=4318 -e PUBLIC_URL=http://127.0.0.1:4318/ -e DATA_DIR=/app/data \
  -v "$smoke_volume:/app/data" "$image" >/dev/null
}
wait_healthy(){
 for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$smoke_container")"
  [ "$status" = healthy ] && return 0
  [ "$status" = unhealthy ] && { docker logs "$smoke_container" >&2; return 1; }
  sleep 1
 done
 docker logs "$smoke_container" >&2
 return 1
}
run_smoke
wait_healthy
curl --fail --silent --show-error http://127.0.0.1:4318/ | grep -F "SIMPLY BRIDGE · v${version}" >/dev/null
[ "$(docker inspect --format '{{.Config.User}}' "$smoke_container")" = node ]
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$smoke_container" | grep -Fx 'DATA_DIR=/app/data' >/dev/null
[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$smoke_container")" = "$smoke_volume" ]
docker exec "$smoke_container" node -e "const fs=require('node:fs');fs.writeFileSync(process.env.DATA_DIR+'/persistence-probe','survives-recreate')"
docker restart "$smoke_container" >/dev/null
wait_healthy
[ "$(docker exec "$smoke_container" node -e "process.stdout.write(require('node:fs').readFileSync(process.env.DATA_DIR+'/persistence-probe','utf8'))")" = survives-recreate ]
docker rm -f "$smoke_container" >/dev/null
run_smoke
wait_healthy
[ "$(docker exec "$smoke_container" node -e "process.stdout.write(require('node:fs').readFileSync(process.env.DATA_DIR+'/persistence-probe','utf8'))")" = survives-recreate ]
docker exec "$smoke_container" node -e "const dns=require('node:dns').promises;(async()=>{const a=await dns.resolve4('github.com');if(!a.length)throw Error('No IPv4 DNS result');const r=await fetch('https://github.com',{redirect:'manual'});if(r.status<200||r.status>=400)throw Error('External HTTPS failed: '+r.status)})()"
docker exec "$smoke_container" node -e "require('node:fs').unlinkSync(process.env.DATA_DIR+'/persistence-probe')"
cleanup_smoke
trap - EXIT

docker tag "$image" "$current"
docker image save -o "$release_dir/simply-bridge-update.tar" "$image" "$current"
docker image inspect "$image" > "$release_dir/image-info.json"
printf '%s\n' "$platform" > "$release_dir/platform.txt"
cp deploy/compose.yaml deploy/compose-ca.yaml deploy/.env.example deploy/install-offline.sh deploy/DEPLOY.md deploy/UPDATE-PODMAN.txt deploy/README-RED-UPDATE.md deploy/README-BLACK-FRESH-INSTALL.md "$release_dir/"
(cd "$release_dir" && sha256sum simply-bridge-update.tar image-info.json platform.txt compose.yaml compose-ca.yaml .env.example install-offline.sh DEPLOY.md README-BLACK-FRESH-INSTALL.md > SHA256SUMS && zip -q "simply-bridge-${version}-BLACK-FRESH-INSTALL.zip" simply-bridge-update.tar image-info.json platform.txt compose.yaml compose-ca.yaml .env.example install-offline.sh DEPLOY.md README-BLACK-FRESH-INSTALL.md SHA256SUMS && sha256sum simply-bridge-update.tar > RED-SHA256SUMS.txt && zip -q "simply-bridge-${version}-RED-UPDATE.zip" simply-bridge-update.tar README-RED-UPDATE.md RED-SHA256SUMS.txt)
printf 'Offline bundle: %s/simply-bridge-offline.zip\n' "$release_dir"
