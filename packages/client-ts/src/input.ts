import { createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { FabricError, type EphemeralInputRequest, type WorkerId } from "@browser-fabric/contracts";

export interface EncryptedInputEnvelope {
  version: 1;
  algorithm: "rsa-oaep-sha256+a256gcm";
  requestId: EphemeralInputRequest["id"] | string;
  workerId: WorkerId | string;
  expiresAt: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Encrypt a transient value for exactly the worker named by an input request. */
export function encryptInputForWorker(input: {
  request: Pick<EphemeralInputRequest, "id" | "expiresAt" | "workerId" | "workerInputEncryptionPublicKeyPem">;
  value: string;
  now?: Date;
}): EncryptedInputEnvelope {
  if (!input.request.workerId || !input.request.workerInputEncryptionPublicKeyPem) throw new FabricError("worker_unavailable", "input request does not contain a worker encryption key", 503);
  if (!input.value || Buffer.byteLength(input.value, "utf8") > 16_384) throw new FabricError("validation_failed", "ephemeral input must be non-empty and at most 16KiB", 400);
  const expiresAt = new Date(input.request.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= (input.now ?? new Date()).getTime()) throw new FabricError("invalid_state", "input request has expired", 409);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  try {
    const wrappedKey = publicEncrypt({ key: input.request.workerInputEncryptionPublicKeyPem as any, oaepHash: "sha256" }, key);
    return {
      version: 1,
      algorithm: "rsa-oaep-sha256+a256gcm",
      requestId: input.request.id,
      workerId: input.request.workerId,
      expiresAt: input.request.expiresAt,
      wrappedKey: wrappedKey.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  } finally {
    key.fill(0);
  }
}
