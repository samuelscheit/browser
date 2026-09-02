FROM oven/bun:1.4.1-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fabric-input-broker \
    && chown -R fabric-input-broker:fabric-input-broker /app
USER 10001:10001
ENV HOME=/tmp
CMD ["bun", "apps/input-broker/src/index.ts"]
