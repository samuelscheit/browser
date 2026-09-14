FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker-cli ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy
RUN bun install --frozen-lockfile
# The controller is the single narrowly-scoped trusted component allowed to use the Swarm API.
# Browser worker containers never inherit this socket or image.
ENV HOME=/tmp
CMD ["bun", "apps/worker-manager/src/server.ts"]
