import { generateWorkerInputKeyPair } from "@browser-fabric/control-plane";

const pair = generateWorkerInputKeyPair(Number(process.env.FABRIC_INPUT_RSA_BITS ?? 3072));
console.log("# Store private key only on the named worker; publish public key through its registration.");
console.log("FABRIC_INPUT_PRIVATE_KEY<<PEM");
console.log(pair.privateKeyPem.trim());
console.log("PEM");
console.log("FABRIC_INPUT_PUBLIC_KEY<<PEM");
console.log(pair.publicKeyPem.trim());
console.log("PEM");
