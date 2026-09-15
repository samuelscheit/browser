import { startPrivateCdpBridge } from "./index";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Fabric private CDP bridge`);
  return value;
}

function port(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1_024 || value > 65_535) throw new Error(`${name} must be a private TCP port from 1024 to 65535`);
  return value;
}

const bridge = await startPrivateCdpBridge({
  peerHost: required("FABRIC_CDP_BRIDGE_PEER_HOST"),
  listenPort: port("FABRIC_CDP_BRIDGE_PORT"),
  chromiumPort: port("FABRIC_CHROMIUM_CDP_PORT"),
});

const readyFile = "/tmp/fabric-cdp-bridge.ready";
await Bun.write(readyFile, `${bridge.bindAddress}\n`);
console.info(`Fabric private CDP bridge listening on ${bridge.bindAddress}:${port("FABRIC_CDP_BRIDGE_PORT")}`);
const shutdown = () => void bridge.close().finally(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
