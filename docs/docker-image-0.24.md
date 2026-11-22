# Docker image handoff for Simply Bridge 0.24.0

The `feature/relation-finalizer-024` branch has a manually dispatched GitHub
Actions build. After verifying that branch on GitHub, start it with:

```sh
gh workflow run offline-docker.yml --ref feature/relation-finalizer-024
```

The workflow checks out the exact commit, runs the regression suite, builds the
image for `linux/amd64`, verifies Node/SQLite and container health, then uploads
one TAR and its checksum. The TAR contains one image ID with both the versioned
tag and the existing `current` tag, so existing environment values continue to
work.

To build and test locally on a host with Docker Engine:

```sh
docker build --platform linux/amd64 -t simply-bridge:0.24.0 .
docker tag simply-bridge:0.24.0 simply-bridge:current
docker run --rm --entrypoint node simply-bridge:0.24.0 --version
docker save -o simply-bridge-0.24.0-linux-amd64.tar simply-bridge:0.24.0 simply-bridge:current
sha256sum simply-bridge-0.24.0-linux-amd64.tar
docker load -i simply-bridge-0.24.0-linux-amd64.tar
docker run -d --rm --name simply-bridge-smoke simply-bridge:0.24.0
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
