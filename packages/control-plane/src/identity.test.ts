import { X509Certificate } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  certificateFingerprintFromForwardedHeader,
  forwardedClientCertificate,
  normalizeCertificateFingerprint,
} from "./identity";

// Public-only, short-lived fixture. The test verifies the Cloudflare DER
// forwarding shape without embedding any private key material in the source.
const certificatePem = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUCYCSTu4V+a6XfnDKeR4B/UQy17QwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaYnJvd3Nlci1mYWJyaWMtdGVzdC1jbGllbnQwHhcNMjYw
OTE0MTY1MzI5WhcNMjYwOTE1MTY1MzI5WjAlMSMwIQYDVQQDDBpicm93c2VyLWZh
YnJpYy10ZXN0LWNsaWVudDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKx3OtytkCMK+VH80BoLswoes76aoDm3S2GlBUGBGV08CiQf+fdT8ImHLJx5S9Ax
LYgGyQn42p61iotPppLLAet/YbfSr3A7Y+3AyGSK/hpW4QphN3rNDpzwwaf0lIef
rYQGa3xwb33yhhVKxLA8oyE+XRe7VASSqXJ+S9jGTi8epQcBT1xtJLsh7qtNKv7R
Ui5G62ddUelipMsSFRiSyHMsgBY/QnTN6Sis70w+1oamFeHJ2r/KtuBe/y+jiBm3
vRRvG/dN8WQfDLuHnEmgysVMDj7G6h+1Gjhxg+e1ndy9nryTszEP1vfxdSWuVmOp
cgVb/3xH6RPnkLodV6pYXgcCAwEAAaNTMFEwHQYDVR0OBBYEFIyK94KZlemtoCOe
u2GYiKIc9w9zMB8GA1UdIwQYMBaAFIyK94KZlemtoCOeu2GYiKIc9w9zMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAFqTcUbsaLm1axYQIoFltZV8
gI5tpmzcmjJ6zQUvz0k52WOU0Zps7sTX5W9ZwhIfrFQLNZpo77tL0XAFQwXpMXFO
wwhLF5QQi0ajyS2GZLHZeBHTRTIHWyGfjg7ozitZe8vrjYvCepG2w8vB6XMBHz6L
Kp9e+4yUZeBpL50jvVxoNs5joX3QeinVshwOspWOMTpsS9EG0ZfBKw7PSTgrkpGP
tfC5SzuB7Zmo8OJ7d58Hy/JtrFxZkSNEWS2MTGYSg0XwWQ7awX/KlhstlAbOGQgX
f16l7P3RcavRrm1w5ITZbHRmHHdRfB9NapG8wfjTs1OdmbioUm2ZFK4kbtOeEBw=
-----END CERTIFICATE-----`;

describe("forwarded Fabric client certificates", () => {
  test("derives the identity from Cloudflare's verified DER forwarding format", () => {
    const certificate = new X509Certificate(certificatePem);
    const forwardedDer = Buffer.from(certificate.raw).toString("base64");
    const request = new Request("https://browser.example.test/v1/browser-sessions", {
      headers: { "cf-client-cert-der-base64": forwardedDer },
    });

    expect(forwardedClientCertificate(request)).toBe(forwardedDer);
    expect(certificateFingerprintFromForwardedHeader(forwardedDer))
      .toBe(normalizeCertificateFingerprint(certificate.fingerprint256));
  });

  test("rejects malformed DER forwarding values", () => {
    expect(certificateFingerprintFromForwardedHeader("not-a-certificate")).toBeUndefined();
  });
});
