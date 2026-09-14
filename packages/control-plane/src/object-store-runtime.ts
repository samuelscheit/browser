import { readFile } from "node:fs/promises";
import { S3HttpClient, S3ObjectStore } from "./object-store";

export interface ProductionObjectStoreOptions {
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

async function secret(name: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) return required(name, explicit);
  const file = process.env[`${name}_FILE`];
  if (file) {
    if (!file.startsWith("/run/secrets/") || file.includes("..")) throw new Error(`${name}_FILE must point to a Docker secret`);
    return required(name, await readFile(file, "utf8"));
  }
  // Raw environment values are useful for local development, but a production deployment must
  // use Docker/Compose secret files so credentials do not end up in stack metadata or process
  // inspection output by accident.
  if (process.env.NODE_ENV === "production") throw new Error(`${name}_FILE is required in production`);
  return required(name, process.env[name]);
}

/** Construct the concrete MinIO/S3 object store used by Fabric-owned services. */
export async function createProductionObjectStore(options: ProductionObjectStoreOptions = {}): Promise<S3ObjectStore> {
  const endpoint = required("FABRIC_OBJECT_STORE_ENDPOINT", options.endpoint ?? process.env.FABRIC_OBJECT_STORE_ENDPOINT);
  const bucket = required("FABRIC_OBJECT_STORE_BUCKET", options.bucket ?? process.env.FABRIC_OBJECT_STORE_BUCKET ?? "fabric-artifacts");
  const accessKey = await secret("FABRIC_OBJECT_STORE_ACCESS_KEY", options.accessKey);
  const secretKey = await secret("FABRIC_OBJECT_STORE_SECRET_KEY", options.secretKey);
  const region = options.region ?? process.env.FABRIC_OBJECT_STORE_REGION ?? "us-east-1";
  const client = new S3HttpClient({ endpoint, bucket, accessKey, secretKey, region });
  return new S3ObjectStore(client, bucket);
}
