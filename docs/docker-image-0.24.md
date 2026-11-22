# Docker image handoff for Simply Bridge 0.24.0

Run these commands on a host with Docker Engine after the critical tests pass:

```sh
docker build -t simply-bridge:0.24.0-dev.1 .
docker run --rm --entrypoint node simply-bridge:0.24.0-dev.1 --version
docker save -o simply-bridge-0.24.0-dev.1.tar simply-bridge:0.24.0-dev.1
sha256sum simply-bridge-0.24.0-dev.1.tar
docker load -i simply-bridge-0.24.0-dev.1.tar
docker run -d --rm --name simply-bridge-smoke simply-bridge:0.24.0-dev.1
docker exec simply-bridge-smoke node /app/deploy/healthcheck.mjs
docker stop simply-bridge-smoke
```

Transfer the TAR and its SHA256 value to each offline network. Load the same image
there, then run `docker compose --env-file /path/to/existing.env -f deploy/compose.yaml up -d`.
The Compose file keeps using the existing environment values and named data volume;
no connection or import settings need to be re-entered.

After startup, verify the container is healthy with
`docker compose --env-file /path/to/existing.env -f deploy/compose.yaml ps` and confirm the
existing Bridge data volume is mounted. Keep the TAR and checksum together for
transfer verification.
