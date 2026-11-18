# docker.canvas-captured

An independently deployed, stateless website capture role: an HTTP(S) URL in,
one self-contained HTML file out. A workspace runtime calls this service and
owns storage, indexing and `derived-from` relations. The service neither mounts
workspaces nor accesses Canvas databases. It does not start other Canvas units.

`compose.yaml` is the deployment definition. Deploy it on the dedicated Docker
VM; it is not managed by the parked hub role manager. The web rule builder and
workspace capture client are separate integration work.

## Deploy on the VM

Use a Linux VM with Docker Engine 28+ and Compose v2, unprivileged user namespaces,
at least 2 vCPU and 4 GiB RAM. No browser or Node installation is required on
the host. Start with one concurrent capture; the capture container is limited
to 2 GiB RAM, 2 CPUs and 256 processes. The initial browser image is substantial;
budget several GiB of disk for builds and image updates.

Copy/clone `canvas-roles` onto the VM, then:

```sh
cd canvas-roles/docker.canvas-captured
docker compose build --pull
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/role" --workdir /role \
  --entrypoint node canvas-captured:0.1.0 scripts/setup.mjs
```

Setup creates `.env` and a random token in `secrets/capture-token` without
overwriting existing files or printing credentials. Edit `.env` and set
`CAPTURE_BIND_ADDRESS` to the VM's **private LAN IP**. The default is loopback.
Allow inbound TCP 8085 only from your Canvas server IPs at the Proxmox firewall
or an equivalent upstream firewall. Docker-published ports require filtering
in the forwarding path; a host INPUT/UFW rule alone may not restrict them.

```sh
docker compose up -d --wait
docker compose ps
docker compose logs --tail 50 captured
```

All three services must be healthy. Preserve `secrets/capture-token` and give its
value to authorized Canvas instances through their secret configuration.
The Compose secret is a read-only file, not a credential baked into the image.
Keep `secrets/` private to the host owner. Do not mount the Docker socket.

For a manual request (on the VM, using its configured bind address):

```sh
CAPTURE_URL=http://YOUR_VM_PRIVATE_IP:8085
curl --fail-with-body "$CAPTURE_URL/v1/captures" \
  -H "Authorization: Bearer $(cat secrets/capture-token)" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/"}' \
  --dump-header capture.headers --output capture.html
```

The API uses HTTP on the private network. Use a trusted isolated LAN/VPN, or
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
- `503 unavailable`: the ingress relay cannot reach the capture service.
- `504 capture_timeout`: capture exceeded its deadline.

Clients should use a request deadline slightly longer than `timeoutMs` and
retry transient failures with backoff. Disconnecting cancels capture, kills
the process group and removes temporary files. There is no durable queue or
result cache here; the workspace owns retry scheduling and idempotency.

## Isolation and networking

- `api` is a small non-root nginx ingress relay. It publishes the API port and
  forwards only to `captured`; it does not run a browser or hold the token.
- `captured` belongs only to the dedicated **internal Docker network**. It has
  no published ports and no direct Internet route. The separate ingress relay
  makes API publishing independent of Docker's internal-network port behavior.
  The bridge uses isolated gateway mode, so it has no host gateway address.
- `egress` joins that network and a separate Internet bridge. It listens only
  on its internal-network address, publishes no port and has no API secret.
- Chromium routes requests through `egress`, including localhost destinations;
  QUIC and non-proxied WebRTC UDP are disabled. No direct fallback is configured.
- The proxy validates every HTTP destination and HTTPS CONNECT, denies
  local/private/link-local/reserved/transition ranges and the Azure host virtual
  IP, validates **all** DNS answers and connects to the chosen literal IP.
  Redirects, frames and subresources must pass the same proxy policy. It never
  resolves the hostname a second time when opening the socket.
- Each capture has a fresh browser process/profile and a private temporary
  directory. All container capabilities are dropped. Root filesystems are
  read-only; temporary storage, RAM, CPU, PIDs and connections are bounded.
- `bin/chromium-sandboxed` removes SingleFile's default `--no-sandbox` argument.
  The seccomp policy allows Chromium's unprivileged namespace/chroot operations;
  other Docker default restrictions remain. Neither privileged mode nor
  `SYS_ADMIN` nor an unconfined seccomp profile is needed.

The internal Docker subnet defaults to `172.30.86.0/24`. Change the three-octet
`CAPTURE_NETWORK_PREFIX` if it overlaps the VM's LAN/VPN. Do not attach captured
to a normal bridge or the Canvas service network. Do not attach unrelated
services to its dedicated network. Keep the VM free of sensitive services;
the VM is an additional boundary for processing untrusted websites.

## Validation and updates

With Node 24+ on a development machine:

```sh
npm ci --ignore-scripts
npm test
npx -y knip@5
docker compose build
npm run test:docker
```

The Docker smoke test uses a temporary Compose project, token, random loopback
port and `172.30.87.0/24` network. It captures `https://example.com`, verifies
HTML and checksum, exercises auth/byte/time limits, verifies direct Internet
egress is blocked, tests private targets through the actual proxy and checks
temporary-file cleanup. It removes its containers/networks on exit.

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
