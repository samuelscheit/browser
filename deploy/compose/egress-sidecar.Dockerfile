# The egress sidecar: the only Fabric service with a route to the internet.
FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fabric-egress \
    && mkdir -p /tmp \
    && chown -R fabric-egress:fabric-egress /app /tmp
USER 10001:10001
ENV HOME=/tmp \
    FABRIC_EGRESS_CONFIG=/etc/browser-fabric/egress-sidecar.json \
    FABRIC_EGRESS_PAC_PORT=8080 \
    FABRIC_EGRESS_PAC_HOST=fabric-egress-sidecar
CMD ["bun", "apps/egress-sidecar/src/server.ts"]
