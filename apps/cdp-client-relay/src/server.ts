import { createCdpClientRelayServer, relayConfigFromEnvironment } from "./index";

const config = relayConfigFromEnvironment();
const port = Number(process.env.PORT ?? 8085);
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("PORT must be a private TCP port from 1024 to 65535");
const host = process.env.FABRIC_CDP_RELAY_BIND_HOST ?? "0.0.0.0";
if (host !== "0.0.0.0" && host !== "127.0.0.1") throw new Error("FABRIC_CDP_RELAY_BIND_HOST must be 0.0.0.0 or 127.0.0.1");

const relay = createCdpClientRelayServer(config);
relay.server.listen(port, host, () => {
  console.info(`Browser Fabric CDP client relay listening on ${host}:${port}`);
});
const shutdown = () => void relay.close().finally(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
