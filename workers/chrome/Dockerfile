# Fabric's browser image: the worker agent plus one browser, picked by architecture.
#   amd64: Google Chrome stable, pinned to an exact build and verified by SHA-256.
#   arm64: Debian's Chromium (Google publishes no Linux arm64 Chrome), pinned to an exact version.
# Both resolve their packages from one dated Debian snapshot, so a rebuild installs the same bytes.
# Bump DEBIAN_SNAPSHOT, CHROME_VERSION/CHROME_SHA256 and CHROMIUM_VERSION together.
FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
ARG TARGETARCH
ARG DEBIAN_SNAPSHOT=20261116T000000Z
ARG CHROME_VERSION=157.0.8103.78-1
ARG CHROME_SHA256=4d740636b5c96f687798602c5aad6a5a270f44dd02e48db0638ae77aa4867b1b
ARG CHROMIUM_VERSION=156.0.8078.79-1~deb13u1
RUN set -eu; \
    for archive in debian debian-security; do \
      case "$archive" in debian) suites="trixie trixie-updates" ;; *) suites="trixie-security" ;; esac; \
      printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/%s/%s\nSuites: %s\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\nCheck-Valid-Until: no\n\n' "$archive" "$DEBIAN_SNAPSHOT" "$suites"; \
    done > /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Retries=5 update; \
    common="ca-certificates fonts-liberation fonts-noto-cjk fonts-noto-color-emoji xvfb xauth"; \
    case "$TARGETARCH" in \
      amd64) \
        apt-get install -y --no-install-recommends $common curl; \
        curl -fsSL --retry 5 -o /tmp/google-chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb"; \
        echo "${CHROME_SHA256}  /tmp/google-chrome.deb" | sha256sum -c -; \
        echo 'repo_add_once="false"' > /etc/default/google-chrome; \
        apt-get install -y --no-install-recommends /tmp/google-chrome.deb; \
        rm -f /tmp/google-chrome.deb /etc/apt/sources.list.d/google-chrome.list; \
        apt-get purge -y curl; apt-get autoremove -y; \
        ln -s /usr/bin/google-chrome-stable /usr/local/bin/fabric-browser ;; \
      arm64) \
        apt-get install -y --no-install-recommends $common "chromium=${CHROMIUM_VERSION}" "chromium-common=${CHROMIUM_VERSION}" "chromium-sandbox=${CHROMIUM_VERSION}"; \
        ln -s /usr/bin/chromium /usr/local/bin/fabric-browser ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/local/bin/fabric-browser --version
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
COPY workers ./workers
COPY workers/chrome/config/worker.json /etc/browser-fabric/worker.json
COPY deploy/compose/chromium-launch.sh /usr/local/bin/fabric-chromium-launch
RUN bun install --frozen-lockfile
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fabric-worker \
    && mkdir -p /fabric /tmp \
    && chmod 0555 /usr/local/bin/fabric-chromium-launch \
    && chown -R fabric-worker:fabric-worker /app /fabric /tmp
USER 10001:10001
ENV HOME=/tmp FABRIC_WORKER_CONFIG_FILE=/etc/browser-fabric/worker.json
CMD ["bun", "apps/local-agent/src/server.ts"]
