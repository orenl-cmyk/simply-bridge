# Simply Bridge 0.23.0 — BLACK FRESH INSTALL (DigitalOcean)

Complete offline Linux/AMD64 Docker image package for a new server. The archive includes `simply-bridge-update.tar`, `compose.yaml`, `compose-ca.yaml`, `.env.example`, `install-offline.sh` and SHA256 checksums. It contains **no actual secrets, users, or vault files**.

## Windows CMD — transfer the package

Extract the ZIP locally, open CMD in that directory, and transfer the extracted files to a new empty Linux directory. For example:

```cmd
scp simply-bridge-update.tar compose.yaml compose-ca.yaml .env.example install-offline.sh SHA256SUMS root@SERVER_IP:/opt/simply-bridge/
ssh root@SERVER_IP
```

An administrator must first create `/opt/simply-bridge` on the new server (and ensure it is writable via SCP), and install Docker Engine with the Compose plugin, or use Podman with a compatible Compose provider and manual installation.

## New Linux server — Docker Engine and Compose

```bash
cd /opt/simply-bridge
sha256sum -c SHA256SUMS
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` on the server to set the **actual** `PUBLIC_URL`, `HOST_PORT`, and `BIND_IP`. Keep `BRIDGE_IMAGE=simply-bridge:current` and `DATA_VOLUME=simply-bridge-data`. Do not put secrets in `.env` unless explicitly required by deployment policy.

```bash
docker load -i simply-bridge-update.tar
docker compose -f compose.yaml config
docker compose -f compose.yaml up -d --no-build --pull never
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 bridge
```

Configure HTTPS (TLS reverse proxy), DNS and firewall rules **before** publishing the URL. The included Compose defaults to binding port 4318 on all interfaces; for a public server, prefer `BIND_IP=127.0.0.1` behind a reverse proxy. Do not expose plaintext login or API secrets over HTTP on the public internet.

If an enterprise CA is required, provide `organization-ca.pem` separately and use `docker compose -f compose.yaml -f compose-ca.yaml ...` consistently. First registration and personal SIMPLY API credentials are configured in the running application; no admin password is bundled.

Persistent data lives in Docker volume `simply-bridge-data`. Back it up regularly; never use `docker compose down -v` during upgrades.
