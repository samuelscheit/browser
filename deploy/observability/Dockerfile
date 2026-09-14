# The collector is a private, in-stack telemetry sink. Keep its upstream base
# pinned; the release pipeline replaces this placeholder digest with the
# reviewed digest resolved from the OCI registry before publishing.
FROM otel/opentelemetry-collector-contrib:0.127.0@sha256:e94cfd92357aa21f4101dda3c0c01f90e6f24115ba91b263c4d09fed7911ae68
COPY deploy/observability/otel-collector.yml /etc/otelcol-contrib/config.yaml
ENTRYPOINT ["/otelcol-contrib"]
CMD ["--config=/etc/otelcol-contrib/config.yaml"]
