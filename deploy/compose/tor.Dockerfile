# Optional Tor client for the `tor` egress listener (compose profile "tor").
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
RUN apk add --no-cache tor \
    && addgroup -S fabric-tor \
    && adduser -S -D -H -G fabric-tor fabric-tor \
    && mkdir -p /tmp/tor-data \
    && chown -R fabric-tor:fabric-tor /tmp/tor-data
COPY deploy/compose/torrc /etc/tor/torrc
USER fabric-tor:fabric-tor
ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
