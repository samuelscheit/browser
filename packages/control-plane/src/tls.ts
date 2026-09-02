/**
 * TLS helpers for private Fabric services. Certificate material is read from Docker secrets at
 * process startup and is never returned through an API or written to durable Fabric state.
 */
export interface MtlsFiles {
  certificateFile: string;
  privateKeyFile: string;
  clientCaFile: string;
}

export function bunMtlsServerTls(files: MtlsFiles): Bun.TLSOptions {
  return {
    cert: Bun.file(files.certificateFile),
    key: Bun.file(files.privateKeyFile),
    ca: Bun.file(files.clientCaFile),
    requestCert: true,
    rejectUnauthorized: true
  };
}

export function mtlsFilesFromEnv(prefix: string): MtlsFiles | undefined {
  const certificateFile = process.env[`${prefix}_CERT_FILE`];
  const privateKeyFile = process.env[`${prefix}_KEY_FILE`];
  const clientCaFile = process.env[`${prefix}_CLIENT_CA_FILE`];
  if (!certificateFile && !privateKeyFile && !clientCaFile) return undefined;
  if (!certificateFile || !privateKeyFile || !clientCaFile) throw new Error(`${prefix} mTLS requires certificate, key, and client CA files`);
  return { certificateFile, privateKeyFile, clientCaFile };
}
