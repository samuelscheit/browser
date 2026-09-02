import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signDetached,
  verify as verifyDetached,
  type KeyObject
} from "node:crypto";
import { canonicalJson, FabricError, type WorkerAssignment, type WorkerId } from "@browser-fabric/contracts";

export interface SignedAssignment {
  version: 1;
  algorithm: "ed25519";
  workerId: WorkerId;
  assignment: WorkerAssignment;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

type UnsignedAssignment = Omit<SignedAssignment, "signature">;

function signingBytes(value: UnsignedAssignment): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function asPrivateKey(value: string | KeyObject): KeyObject {
  const key = typeof value === "string" ? createPrivateKey(value) : value;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("assignment signing key must be Ed25519");
  return key;
}

function asPublicKey(value: string | KeyObject): KeyObject {
  const key = typeof value === "string" ? createPublicKey(value) : value;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("assignment verification key must be Ed25519");
  return key;
}

/** Public-key-only verifier safe to ship to each worker. */
export class AssignmentVerifier {
  readonly #publicKey: KeyObject;
  readonly #clock: () => Date;

  public constructor(publicKey: string | KeyObject, clock: () => Date = () => new Date()) {
    this.#publicKey = asPublicKey(publicKey);
    this.#clock = clock;
  }

  public verify(envelope: SignedAssignment, expectedWorkerId: WorkerId): WorkerAssignment {
    if (envelope.version !== 1 || envelope.algorithm !== "ed25519" || envelope.workerId !== expectedWorkerId) {
      throw new FabricError("capability_invalid", "assignment is not addressed to this worker", 401);
    }
    if (!envelope.nonce || new Date(envelope.expiresAt).getTime() <= this.#clock().getTime()) {
      throw new FabricError("capability_expired", "assignment has expired", 401);
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(envelope.signature, "base64url");
    } catch {
      throw new FabricError("capability_invalid", "assignment signature is malformed", 401);
    }
    const { signature: _ignored, ...unsigned } = envelope;
    if (!verifyDetached(null, signingBytes(unsigned), this.#publicKey, signature)) {
      throw new FabricError("capability_invalid", "assignment signature is invalid", 401);
    }
    return structuredClone(envelope.assignment);
  }

  public exportPublicKeyPem(): string {
    return this.#publicKey.export({ format: "pem", type: "spki" }).toString();
  }
}

/** Manager-only Ed25519 signer. Keep the private PEM in a Docker secret, never on workers. */
export class AssignmentSigner {
  readonly #privateKey: KeyObject;
  readonly #verifier: AssignmentVerifier;
  readonly #clock: () => Date;

  public constructor(privateKey: string | KeyObject, clock: () => Date = () => new Date()) {
    this.#privateKey = asPrivateKey(privateKey);
    this.#clock = clock;
    this.#verifier = new AssignmentVerifier(createPublicKey(this.#privateKey), clock);
  }

  public static generate(clock: () => Date = () => new Date()): AssignmentSigner {
    const { privateKey } = generateKeyPairSync("ed25519");
    return new AssignmentSigner(privateKey, clock);
  }

  public issue(workerId: WorkerId, assignment: WorkerAssignment, ttlSeconds = 60): SignedAssignment {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw new FabricError("validation_failed", "assignment TTL is outside safe bounds", 400);
    const issuedAt = this.#clock().toISOString();
    const expiresAt = new Date(this.#clock().getTime() + ttlSeconds * 1_000).toISOString();
    const unsigned: UnsignedAssignment = {
      version: 1,
      algorithm: "ed25519",
      workerId,
      assignment,
      issuedAt,
      expiresAt,
      nonce: crypto.randomUUID()
    };
    return { ...unsigned, signature: signDetached(null, signingBytes(unsigned), this.#privateKey).toString("base64url") };
  }

  public verifier(): AssignmentVerifier { return this.#verifier; }
  public exportPrivateKeyPem(): string { return this.#privateKey.export({ format: "pem", type: "pkcs8" }).toString(); }
  public exportPublicKeyPem(): string { return this.#verifier.exportPublicKeyPem(); }
}
