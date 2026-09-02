FROM oven/bun:1.4.1-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy
RUN bun install --frozen-lockfile
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fabric-api \
    && chown -R fabric-api:fabric-api /app
USER 10001:10001
ENV HOME=/tmp
CMD ["bun", "apps/api/src/server.ts"]
