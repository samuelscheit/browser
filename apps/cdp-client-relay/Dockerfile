FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6

WORKDIR /app

COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fabric-cdp-relay \
    && chown -R fabric-cdp-relay:fabric-cdp-relay /app

USER 10001:10001
ENV HOME=/tmp

CMD ["bun", "apps/cdp-client-relay/src/server.ts"]
