import { X509Certificate } from "node:crypto";

/** Normalize the formats used by OpenSSL, Traefik, and provisioned Fabric records. */
export function normalizeCertificateFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "").replaceAll(":", "").replace(/\s+/g, "");
}

export function certificateFingerprintsEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizeCertificateFingerprint(left);
  const normalizedRight = normalizeCertificateFingerprint(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

/**
 * Parse the client certificate forwarded by Traefik's passTLSClientCert middleware. Traefik may
 * escape line breaks in the HTTP header, so accept both literal and escaped PEM forms. Invalid
 * headers are rejected rather than treated as an identity claim.
 */
export function certificateFingerprintFromForwardedHeader(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* use the original header */ }
  const candidates = [value, value.replaceAll("\\n", "\n"), decoded];
  for (const candidate of candidates) {
    try {
      const fingerprint = new X509Certificate(candidate).fingerprint256;
      if (fingerprint) return normalizeCertificateFingerprint(fingerprint);
    } catch {
      // Try the next transport encoding.
    }
  }
  return undefined;
}

export function forwardedClientCertificate(request: Request): string | undefined {
  return request.headers.get("x-fabric-client-cert") ?? request.headers.get("x-forwarded-tls-client-cert") ?? undefined;
}
