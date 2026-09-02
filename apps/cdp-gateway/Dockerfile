FROM oven/bun:1.4.1-slim
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
