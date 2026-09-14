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

  // Cloudflare Access can forward a verified client certificate as DER encoded
  // with base64 in Cf-Client-Cert-Der-Base64. The loopback-only Fabric edge
  // copies that value into X-Fabric-Client-Cert only after Cloudflare has
  // completed the outer mTLS handshake. Supporting DER here keeps the control
  // plane's identity check certificate-derived instead of trusting a claimed
  // fingerprint header at the tunnel boundary.
  for (const candidate of candidates) {
    if (candidate.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) continue;
    try {
      const fingerprint = new X509Certificate(Buffer.from(candidate, "base64")).fingerprint256;
      if (fingerprint) return normalizeCertificateFingerprint(fingerprint);
    } catch {
      // A malformed forwarding header is not an identity.
    }
  }
  return undefined;
}

export function forwardedClientCertificate(request: Request): string | undefined {
  return request.headers.get("x-fabric-client-cert")
    ?? request.headers.get("x-forwarded-tls-client-cert")
    ?? request.headers.get("cf-client-cert-der-base64")
    ?? undefined;
}
