FROM oven/bun:1.4.1-slim
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
