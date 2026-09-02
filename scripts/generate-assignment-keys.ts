import { generateKeyPairSync } from "node:crypto";

/**
 * Print Ed25519 assignment keys in PEM form for a secret manager. The private key is intentionally
 * written only to stdout; redirect it directly into a secret manager, never into the repository.
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log("# Store the following two values as separate secret-manager entries.");
console.log("FABRIC_ASSIGNMENT_PRIVATE_KEY<<PEM");
console.log(privateKey.export({ format: "pem", type: "pkcs8" }).toString().trim());
console.log("PEM");
console.log("FABRIC_ASSIGNMENT_PUBLIC_KEY<<PEM");
console.log(publicKey.export({ format: "pem", type: "spki" }).toString().trim());
console.log("PEM");
