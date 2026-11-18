# Rebuild regularly for Debian/Chromium security updates; promote the tested image by digest.
FROM node:24.22.3-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM dependencies AS egress
COPY src/errors.js src/config.js src/token.js src/init-token.js src/network-policy.js src/proxy.js ./src/
COPY LICENSE ./LICENSE
USER node
CMD ["node", "src/proxy.js"]

FROM dependencies AS capture
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY LICENSE ./LICENSE
COPY --chmod=755 bin/chromium-sandboxed ./bin/chromium-sandboxed
USER node
EXPOSE 8085
CMD ["node", "src/server.js"]
