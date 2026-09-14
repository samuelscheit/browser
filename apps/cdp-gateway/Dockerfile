FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy
RUN bun install --frozen-lockfile
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fabric-gateway \
    && chown -R fabric-gateway:fabric-gateway /app
USER 10001:10001
ENV HOME=/tmp
CMD ["bun", "apps/cdp-gateway/src/server.ts"]
