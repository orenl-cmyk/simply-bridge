# Simply Bridge 0.23.0 — RED UPDATE (image only)

This is for an **existing Podman deployment**. It contains the full Linux/AMD64 image but no replacement `.env`, Compose configuration, certificates, or data files.

## Windows CMD — upload

1. Extract the ZIP. Keep `simply-bridge-update.tar`, `RED-SHA256SUMS.txt` and this README together.
2. In CMD, move into the extracted directory and check the file:

```cmd
certutil -hashfile simply-bridge-update.tar SHA256
scp simply-bridge-update.tar root@SERVER_IP:/root/simply-bridge-update-0.23.0.tar
ssh root@SERVER_IP
```

Replace `SERVER_IP` with the actual red-server address. Do not share credentials in chat or GitHub.

## On the existing Linux server

```bash
sha256sum /root/simply-bridge-update-0.23.0.tar
podman load -i /root/simply-bridge-update-0.23.0.tar
podman images simply-bridge
cd ~/simply-bridge
grep '^BRIDGE_IMAGE=' .env
podman compose config | grep -i image
```

Compare the SHA256 with the result from Windows. **Stop if they differ.** The existing `.env` should already specify `BRIDGE_IMAGE=simply-bridge:current`. If not, STOP: the install procedure needs a separate review, because changing `.env` is outside this image-only update.

If this server uses `compose-ca.yaml` or other extra Compose files, use the same Compose command and files as before. After confirming the image tag and Compose rendering, run:

```bash
podman compose up -d --no-build --force-recreate
podman compose ps
podman compose logs --tail=100 bridge
```

If this server uses `podman-compose`, use that instead of `podman compose` for the equivalent commands.

This update **does not overwrite** `.env`, `compose.yaml`, CA files, or the named data volume. Do not run `podman compose down -v`. Back up the persistent volume before updating. At runtime, the new application may migrate its stored data; confirm rollback compatibility separately.

Verify application version 0.23.0 and test login and a safe read-only operation. Retain the previous versioned image for rollback.
