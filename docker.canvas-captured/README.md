# docker.canvas-captured

An independently deployed, stateless website capture role: an HTTP(S) URL in,
one self-contained HTML file out. A workspace runtime calls this service and
owns storage, indexing and `derived-from` relations. The service neither mounts
workspaces nor accesses Canvas databases. It does not start other Canvas units.

`compose.yaml` is the deployment definition. Deploy it on the dedicated Docker
VM; it is not managed by the parked hub role manager. The web rule builder and
workspace capture client are separate integration work.

## Deploy on the VM

Use a dedicated Linux DMZ VM with Docker Engine and Compose v2, unprivileged user namespaces,
at least 2 vCPU and 4 GiB RAM. No browser or Node installation is required on
the host. Start with one concurrent capture; the capture container is limited
to 2 GiB RAM, 2 CPUs and 256 processes. The initial browser image is substantial;
budget several GiB of disk for builds and image updates.

Copy/clone `canvas-roles` onto the VM, then:

```sh
cd canvas-roles/docker.canvas-captured
CAPTURE_BIND_ADDRESS=YOUR_VM_DMZ_IP docker compose up -d --build --wait
```

Startup automatically creates `secrets/capture-token` if it is missing. The
256-bit random token is persisted, never printed and never overwritten.
For persistent configuration, copy `.env.example` to `.env` and set
`CAPTURE_BIND_ADDRESS` to the VM's **DMZ IP**. Without configuration the API
binds to loopback. `CAPTURE_SECRETS_DIR` selects a dedicated host directory
(default `./secrets`); do not point it at a directory shared with another service.
Allow inbound TCP 8085 only from your Canvas server IPs at the Proxmox firewall
or the VM's host firewall. Both containers use Linux host networking: the API
binds directly to `CAPTURE_BIND_ADDRESS:CAPTURE_PORT` (default port 8085).
The proxy binds only to `127.0.0.1:CAPTURE_PROXY_PORT` (default port 3128).
These ports must be free on the VM; there are no Docker port mappings or bridges.

```sh
docker compose ps
docker compose logs --tail 50 captured
```

The `token-init` container must exit successfully; `captured` and `egress` must
be healthy. Preserve `secrets/capture-token` and give its
value to authorized Canvas instances through their secret configuration.
The initializer has no network and exits before capture starts. It owns the
dedicated secrets directory as uid/gid 1000 with mode 0700 and the token as
0400. The capture container mounts the directory read-only. Neither the token
nor its value is baked into the image or stored in Compose environment variables.
Use `sudo cat secrets/capture-token` if your host user cannot read it.
Do not mount the Docker socket.

An existing empty, malformed or non-regular token file causes startup to fail;
it is never silently replaced. To replace a known invalid file while retaining
it for inspection, move it aside and restart:

```sh
mv secrets/capture-token "secrets/capture-token.invalid.$(date +%s)"
CAPTURE_BIND_ADDRESS=YOUR_VM_DMZ_IP docker compose up -d --build --wait
```

Rebuilding or recreating containers preserves a valid token. Deleting the token
file deliberately rotates it on the next startup, so callers must receive the
new value.

For a manual request (on the VM, using its configured bind address):

```sh
CAPTURE_URL=http://YOUR_VM_DMZ_IP:8085
curl --fail-with-body "$CAPTURE_URL/v1/captures" \
  -H "Authorization: Bearer $(cat secrets/capture-token)" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/"}' \
  --dump-header capture.headers --output capture.html
```

The API uses HTTP on the DMZ network. Use a trusted isolated LAN/VPN, or
terminate TLS on an internal reverse proxy when transport encryption is
required. Bearer authentication alone does not encrypt requests or HTML.

## API v1.0

`GET /healthz` is unauthenticated and reports `{ "status": "ok", "api": {
"major": 1, "minor": 0 } }`. The API starts listening only after sandboxed
Chromium successfully launches. This is liveness, not a public Internet probe.

`POST /v1/captures` requires `Authorization: Bearer <service-token>` and
`Content-Type: application/json`:

```json
{
  "url": "https://example.com/article",
  "timeoutMs": 120000,
  "maxBytes": 33554432
}
```

Only `url` is required. The other arguments can lower, but cannot exceed, the
deployment limits. Unknown arguments are rejected with their allowed names.
URLs must use HTTP port 80 or HTTPS port 443 and cannot contain credentials.
There are no arbitrary CLI flags, scripts, headers, cookies or browser profiles.

Success is `200 text/html; charset=utf-8`, delivered as an attachment **after**
the complete file is generated and validated. Headers:

- `X-Capture-Final-Url`: final absolute URL (standard URL percent-encoding).
- `X-Capture-Time`: ISO 8601 UTC completion time.
- `X-Capture-Engine`: SingleFile CLI version.
- `X-Capture-Sha256`: hex SHA-256 of the exact response bytes.

The response disables caching and supplies a restrictive sandbox CSP. A client
that stores/serves the HTML must apply its own sandboxed preview; response
headers are not embedded in downloaded files. Original scripts/audio/video
are excluded. Capture quality depends on the site's loading behavior and
available resources. Public login/error/challenge pages can still be captured;
this service does not use the user's signed-in browser session.

Failures return `{ "error": { "code": "...", "message": "..." } }`:

- `400`: invalid arguments or a visibly disallowed URL.
- `401`: missing/invalid bearer token.
- `413`: request or captured file exceeds the limit.
- `415`: body is not JSON.
- `429 busy`: all capture slots occupied; `Retry-After: 5`.
- `502`: browser, network, DNS, target HTTP response or output validation failed.
- `504 capture_timeout`: capture exceeded its deadline.

Clients should use a request deadline slightly longer than `timeoutMs` and
retry transient failures with backoff. Disconnecting cancels capture, kills
the process group and removes temporary files. There is no durable queue or
result cache here; the workspace owns retry scheduling and idempotency.

## Isolation and networking

- `captured` serves the authenticated API directly on the configured host
  address and port. `egress` serves the public-only HTTP proxy on host loopback.
  Both use `network_mode: host`. No nginx relay or Docker networks are needed.
- `token-init` has no network and only a writable secrets-directory mount. It
  runs as root with CHOWN, DAC_OVERRIDE and FOWNER solely to initialize that
  directory and its file, then exits. The browser and proxy run as uid 1000
  with all container capabilities dropped.
- Chromium routes requests through `egress`, including localhost destinations;
  QUIC and non-proxied WebRTC UDP are disabled. No direct fallback is configured.
- The proxy validates every HTTP destination and HTTPS CONNECT, denies
  local/private/link-local/reserved/transition ranges and the Azure host virtual
  IP, validates **all** DNS answers and connects to the chosen literal IP.
  Redirects, frames and subresources must pass the same proxy policy. It never
  resolves the hostname a second time when opening the socket.
- Each capture has a fresh browser process/profile and a private temporary
  directory. Root filesystems are
  read-only; temporary storage, RAM, CPU, PIDs and connections are bounded.
- `bin/chromium-sandboxed` removes SingleFile's default `--no-sandbox` argument.
  The seccomp policy allows Chromium's unprivileged namespace/chroot operations;
  other Docker default restrictions remain. Neither privileged mode nor
  `SYS_ADMIN` nor an unconfined seccomp profile is needed.

The DMZ VM and its firewall are the network boundary. Host networking gives
container processes access to the VM's network interfaces and loopback services;
Docker does not enforce proxy-only egress. The proxy and browser flags constrain
normal capture traffic, but a compromised process could connect directly.
Keep the VM dedicated to capture and use its DMZ egress policy to limit reachable
destinations. Chromium's temporary debugging listeners also live on host loopback;
do not expose them through the firewall. Host networking does not disable the
browser's process sandbox, read-only filesystem or container resource limits.

## Validation and updates

With Node 24+ on a development machine:

```sh
npm ci --ignore-scripts
npm test
npx -y knip@5
docker compose build
npm run test:docker
```

The Docker smoke test uses a temporary Compose project, empty secrets directory and two free host
ports. It binds the API to `127.0.0.2` to exercise a non-default interface and the
proxy to `127.0.0.1`. It captures `https://example.com`, verifies HTML and checksum,
exercises auth/byte/time limits, verifies host network mode and the proxy's
loopback-only listener, tests private targets through the actual proxy and checks
temporary-file cleanup. It verifies automatic token creation, absence from logs,
the read-only secrets mount and token preservation after container recreation.
It removes its containers on exit.

SingleFile and npm transitive dependencies are pinned by `package-lock.json`.
The Node base version is pinned in `Dockerfile`; Chromium and fonts come from
Debian's security-maintained package repositories at build time. Rebuild with
`docker compose build --pull --no-cache`, run the smoke test, then promote the
tested images by digest in your deployment. Update the Node pin and npm lockfile
regularly; rebuilding a pinned Node tag does not upgrade its Node release.
Record `docker compose images` and the image digests for rollback. Browser
dependencies live only in this role's image, not in Canvas server/CLI packages.

Logs contain outcome codes and durations, not tokens, URLs or page content.
For a sandbox startup failure, verify the supplied seccomp file and host
unprivileged-user-namespace/AppArmor policy. Run this diagnostic under the same
Compose restrictions (it only opens a blank page):

```sh
docker compose run --rm --no-deps --entrypoint /app/bin/chromium-sandboxed \
  -e HOME=/tmp captured --headless --disable-gpu \
  --user-data-dir=/tmp/probe --dump-dom about:blank
```

Fix host namespace support rather than adding `--no-sandbox`, `--privileged`
or disabling AppArmor globally. On authentication failure check the secret
file's readability for uid 1000. On public capture failure check the proxy's
DNS and outbound TCP 80/443 connectivity and the site's availability.

## Licensing

The role code is AGPL-3.0-or-later. SingleFile CLI is AGPL-3.0-or-later; its
dependency sources are available through the pinned npm package and upstream
[SingleFile CLI repository](https://github.com/gildas-lormeau/single-file-cli).
Preserve notices and provide
the corresponding source for deployed builds. The vendored seccomp policy is
derived from Moby's Apache-2.0 profile; see `security/NOTICE` and
`security/LICENSE`.
