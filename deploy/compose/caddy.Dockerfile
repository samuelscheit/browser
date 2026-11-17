# Caddy's official Alpine image ships its binary with cap_net_bind_service. The
# Fabric edge listens on unprivileged port 8080, so retaining that file
# capability makes Linux reject exec under no-new-privileges. Strip only the
# unnecessary file capability at build time and keep the runtime hardening in
# the Compose service.
FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
RUN apk add --no-cache libcap \
    && setcap -r /usr/bin/caddy \
    && apk del libcap
COPY deploy/compose/caddy-entrypoint.sh /usr/local/bin/fabric-caddy-entrypoint
RUN chmod 0555 /usr/local/bin/fabric-caddy-entrypoint
ENTRYPOINT ["/usr/local/bin/fabric-caddy-entrypoint"]
