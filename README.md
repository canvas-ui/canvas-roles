# A collection of Canvas Roles

git-clone this repository into /path/to/canvas/server/*roles* to make them automatically available in your canvas-server instance.  
Default configuration can be set via `canvas-role.json`

## Dependencies

- docker/podman
- nodejs
- npm/yarn
- git, curl

## Independently deployed roles

- [docker.canvas-captured](docker.canvas-captured/README.md): URL-to-HTML capture
  service with sandboxed Chromium and a public-only egress proxy. Deploy its
  Compose stack on a dedicated Docker host; workspace runtimes call its API.

