import { describe, expect, test } from "bun:test";
import { createServer as createTcpServer, connect as connectNet, type Server, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { loadListenerEndpoints, parseEgressConfig, parseProxyEndpoint } from "../apps/egress-sidecar/src/config";
import { selectDialAddress, startProxyListener, type ProxyListener } from "../apps/egress-sidecar/src/proxy";
import { pac } from "../apps/egress-sidecar/src/server";
import { builtInEgressPolicies, egressSidecarListeners, internalEgressProxyUrl } from "@browser-fabric/policy";

const nextPort = (() => {
  let value = 24_000 + Math.floor(Math.random() * 1_000);
  return () => value++;
})();

async function listen(server: Server, host = "127.0.0.1", port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeProxy(listener: ProxyListener): Promise<void> {
  await listener.close().catch(() => undefined);
}

function rawProxyRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectNet({ host: "127.0.0.1", port });
    let output = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("proxy request timed out")); }, 10_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { output += chunk.toString("latin1"); });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); resolve(output); });
  });
}

function testListener(input: Partial<Parameters<typeof startProxyListener>[0]> & { port: number }): Parameters<typeof startProxyListener>[0] {
  return { id: "test", mode: "direct", ...input };
}

describe("Fabric egress sidecar", () => {
  test("validates immutable policy config and generates a fail-closed PAC", () => {
    const config = parseEgressConfig({
      version: 1,
      listeners: [
        { id: "direct", port: 11_000, mode: "direct" },
        { id: "proxy", port: 11_001, mode: "proxy", upstreamUrls: ["http://proxy.example:8080"] },
      ],
      policies: [{ ref: "egress_test@1", defaultListenerId: "proxy", fallbackListenerIds: ["direct"], rules: [{ listenerId: "direct", pathExtensions: [".js"] }] }],
    });
    expect(config.listeners).toHaveLength(2);
    const script = pac(config.policies[0]!, new Map([["direct", 11_000], ["proxy", 11_001]]));
    expect(script).toContain("FindProxyForURL");
    expect(script).toContain("PROXY fabric-egress-sidecar:11001; PROXY fabric-egress-sidecar:11000");
    expect(script).not.toContain("DIRECT");
    expect(() => parseEgressConfig({ version: 1, listeners: [{ id: "bad", port: 11_000, mode: "direct", upstreamUrls: ["http://proxy.example"] }], policies: [{ ref: "egress_test@1", defaultListenerId: "bad" }] })).toThrow();
    expect(parseProxyEndpoint("socks5h://user:pass@proxy.example:1234", true)).toMatchObject({ protocol: "socks5h", host: "proxy.example", port: 1234, username: "user", password: "pass" });
  });

  test("allows an optional workload credential to be provisioned after sidecar startup", async () => {
    const config = parseEgressConfig({
      version: 1,
      listeners: [
        { id: "optional", port: nextPort(), mode: "proxy", upstreamSecretFile: "/run/secrets/not-yet-provisioned", optional: true },
        { id: "fallback", port: nextPort(), mode: "proxy", fallbackToDirect: true, optional: true },
      ],
      policies: [{ ref: "egress_optional@1", defaultListenerId: "optional" }],
    });
    expect(config.listeners[0]?.optional).toBe(true);
    await expect(loadListenerEndpoints(config.listeners[0]!)).resolves.toEqual([]);
    const fallback = startProxyListener(config.listeners[1]!, []);
    await fallback.ready();
    await closeProxy(fallback);
  });

  test("deploys a sidecar listener for every reviewed policy route without mounting solver API keys", async () => {
    const config = parseEgressConfig(await Bun.file(new URL("../deploy/compose/egress-sidecar.json", import.meta.url)).json());
    const listenerIds = new Set(config.listeners.map((listener) => listener.id));
    for (const policy of builtInEgressPolicies) {
      const url = new URL(internalEgressProxyUrl(policy));
      const listener = Object.values(egressSidecarListeners).find((candidate) => candidate.port === Number(url.port));
      expect(listener).toBeDefined();
      expect(listenerIds.has(listener!.id)).toBe(true);
    }
    expect(config.policies.some((policy) => policy.ref.includes("reporting"))).toBe(false);
    expect(config.listeners.some((listener) => listener.id.includes("reporting"))).toBe(false);
    // The residential capture exit is a fixed, credential-free hop to the Fabric-owned
    // VPN node; it never falls back to direct egress, which would expose the server.
    const macExit = config.listeners.find((listener) => listener.id === "home-exit")!;
    expect(macExit).toMatchObject({ port: 11_006, mode: "proxy", upstreamUrls: ["socks5h://fabric-home-exit:1055"] });
    expect(macExit.fallbackToDirect).toBeUndefined();
    expect(macExit.upstreamSecretFile).toBeUndefined();
    expect(config.policies.find((policy) => policy.ref === "egress_home-exit@1")?.defaultListenerId).toBe("home-exit");
    const media = config.policies.find((policy) => policy.ref === "egress_media-proxy-affinity@1")!;
    // Media's Cloudflare zone blocks the host's IPv4 address, so its default route is a direct
    // listener that prefers IPv6 on the IPv6-enabled external egress network.
    expect(media.defaultListenerId).toBe("media-ipv6");
    expect(config.listeners.find((listener) => listener.id === "media-ipv6")).toEqual({ id: "media-ipv6", port: 11_003, mode: "direct", preferredAddressFamily: 6 });
    expect(media.rules?.[0]?.listenerId).toBe("media-direct");
    expect(config.listeners.find((listener) => listener.id === "media-direct")?.allowedHostnameSuffixes).toEqual(["cdn-a.example", "cdn-b.example"]);
    const stack = await Bun.file(new URL("../deploy/compose/browser-fabric.compose.yml", import.meta.url)).text();
    const egressBlock = stack.slice(stack.indexOf("  fabric-egress-sidecar:"), stack.indexOf("\n  fabric-tor:"));
    expect(egressBlock).not.toContain("reporting_solver_credential");
    const externalNetwork = stack.slice(stack.indexOf("\n  fabric-egress-external:\n"), stack.indexOf("\nvolumes:"));
    expect(externalNetwork).toContain("enable_ipv6: true");
  });

  test("validates a direct listener's preferred address family and dials it when published", () => {
    const parse = (listener: Record<string, unknown>) => parseEgressConfig({ version: 1, listeners: [{ id: "direct", port: 11_000, mode: "direct", ...listener }], policies: [{ ref: "egress_test@1", defaultListenerId: "direct" }] });
    expect(parse({ preferredAddressFamily: 6 }).listeners[0]?.preferredAddressFamily).toBe(6);
    expect(() => parse({ preferredAddressFamily: 5 })).toThrow(/4 or 6/);
    expect(() => parseEgressConfig({ version: 1, listeners: [{ id: "proxy", port: 11_000, mode: "proxy", upstreamUrls: ["http://proxy.example:8080"], preferredAddressFamily: 6 }], policies: [{ ref: "egress_test@1", defaultListenerId: "proxy" }] })).toThrow(/only for direct/);

    const dualStack = [{ address: "104.21.0.1", family: 4 }, { address: "2a06:98c1:3121::2", family: 6 }];
    expect(selectDialAddress(dualStack, false, 6)).toBe("2a06:98c1:3121::2");
    expect(selectDialAddress(dualStack, false)).toBe("104.21.0.1");
    // A provider CDN without AAAA records stays reachable over IPv4.
    expect(selectDialAddress([{ address: "104.21.0.1", family: 4 }], false, 6)).toBe("104.21.0.1");
    // The preference never selects a private address.
    expect(selectDialAddress([{ address: "104.21.0.1", family: 4 }, { address: "fd00::1", family: 6 }], false, 6)).toBe("104.21.0.1");
  });

  test("forwards direct HTTP traffic and rejects private targets by default", async () => {
    const origin = createHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`origin:${request.url}`);
    });
    const originPort = await listen(origin);
    const directPort = nextPort();
    const direct = startProxyListener(testListener({ port: directPort, allowPrivateTargets: true }), []);
    await direct.ready();
    try {
      const response = await rawProxyRequest(directPort, `GET http://127.0.0.1:${originPort}/asset HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
      expect(response).toContain("200 OK");
      expect(response).toContain("origin:/asset");
    } finally {
      await closeProxy(direct);
      await close(origin);
    }

    const blockedPort = nextPort();
    const blocked = startProxyListener(testListener({ id: "blocked", port: blockedPort }), []);
    await blocked.ready();
    try {
      const response = await rawProxyRequest(blockedPort, `GET http://127.0.0.1:${originPort}/private HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
      expect(response).toContain("403");
    } finally {
      await closeProxy(blocked);
    }
  });

  test("forwards authenticated HTTP proxy traffic without leaking client proxy headers", async () => {
    const proxy = createTcpServer();
    const proxySockets = new Set<Socket>();
    let connectRequest = "";
    let tunneledRequest = "";
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        socket.pause();
        connectRequest = buffer.slice(0, boundary + 4);
        tunneledRequest = buffer.slice(boundary + 4);
        socket.removeListener("data", onData);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (tunneledRequest.includes("GET ")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nproxy-body");
        else {
          socket.on("data", (body) => {
            tunneledRequest += body.toString("latin1");
            if (tunneledRequest.includes("GET ")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nproxy-body");
          });
          socket.resume();
        }
      };
      socket.on("data", onData);
    });
    const proxyPort = await listen(proxy);
    const listenerPort = nextPort();
    const listener = startProxyListener({ id: "proxy", port: listenerPort, mode: "proxy", allowPrivateTargets: true }, [parseProxyEndpoint(`http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`, true)]);
    await listener.ready();
    try {
      const response = await rawProxyRequest(listenerPort, "GET http://example.test/media HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Basic Y2xpZW50OmNyZWRlbnRpYWw=\r\nConnection: close\r\n\r\n");
      expect(response).toContain("proxy-body");
      expect(connectRequest).toContain("CONNECT example.test:80 HTTP/1.1");
      expect(connectRequest).toContain(`Proxy-Authorization: Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`);
      expect(tunneledRequest).toContain("GET /media HTTP/1.1");
      expect(tunneledRequest).not.toContain("client:credential");
    } finally {
      await closeProxy(listener);
      for (const socket of proxySockets) socket.destroy();
      await close(proxy);
    }
  });

  test("keeps an explicit Fabric media affinity selector on one upstream and strips it before forwarding", async () => {
    const first = createTcpServer();
    const second = createTcpServer();
    const sockets = new Set<Socket>();
    let firstConnections = 0;
    let firstConnects = 0;
    let secondConnects = 0;
    const serveTunnel = (socket: Socket, body: string, record: () => void) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      let responded = false;
      const onData = (chunk: Buffer) => {
        if (responded) return;
        buffer += chunk.toString("latin1");
        if (!buffer.includes("\r\n\r\n")) return;
        responded = true;
        socket.removeListener("data", onData);
        record();
        expect(buffer).not.toContain("fabric:");
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      };
      socket.on("data", onData);
    };
    first.on("connection", (socket) => {
      firstConnections += 1;
      // The first affinity is deliberately forced onto the second configured upstream. Later
      // affinities still begin at upstream one, proving the selector—not the shared client IP—is
      // what remembers the route.
      if (firstConnections === 1) {
        socket.destroy();
        return;
      }
      serveTunnel(socket, "first", () => { firstConnects += 1; });
    });
    second.on("connection", (socket) => serveTunnel(socket, "second", () => { secondConnects += 1; }));
    const firstPort = await listen(first);
    const secondPort = await listen(second);
    const listenerPort = nextPort();
    const listener = startProxyListener(
      { id: "affinity", port: listenerPort, mode: "proxy", allowPrivateTargets: true },
      [
        parseProxyEndpoint(`http://127.0.0.1:${firstPort}`, true),
        parseProxyEndpoint(`http://127.0.0.1:${secondPort}`, true),
      ],
    );
    await listener.ready();
    const request = (key: string) => rawProxyRequest(
      listenerPort,
      `GET http://example.test/media HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Basic ${Buffer.from(`fabric:${key}`).toString("base64")}\r\nConnection: close\r\n\r\n`,
    );
    try {
      const affinityA = "A".repeat(32);
      const affinityB = "B".repeat(32);
      expect(await request(affinityA)).toContain("second");
      expect(await request(affinityB)).toContain("first");
      // A returns to its established second-upstream affinity despite sharing the same source
      // address as B. This is what ties Media's signed handshake to the media relay path.
      expect(await request(affinityA)).toContain("second");
      expect(firstConnects).toBe(1);
      expect(secondConnects).toBe(2);
    } finally {
      await closeProxy(listener);
      for (const socket of sockets) socket.destroy();
      await close(first);
      await close(second);
    }
  });

  test("preserves SOCKS5H remote-DNS semantics", async () => {
    const socks = createTcpServer();
    const sockets = new Set<Socket>();
    let connectHost = "";
    socks.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      let greeted = false;
      let connected = false;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        if (!greeted) {
          if (buffer.length < 3) return;
          expect(buffer[0]).toBe(5);
          expect(buffer[2]).toBe(0);
          socket.write(Buffer.from([5, 0]));
          greeted = true;
          buffer = buffer.subarray(3);
        }
        if (!connected && buffer.length >= 7 && buffer[0] === 5 && buffer[1] === 1) {
          const type = buffer[3];
          if (type !== 3) return;
          const length = buffer[4]!;
          if (buffer.length < 7 + length) return;
          connectHost = buffer.subarray(5, 5 + length).toString("utf8");
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          buffer = buffer.subarray(7 + length);
          connected = true;
        }
        if (connected && buffer.includes("GET ")) {
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nsocks-ok");
          buffer = Buffer.alloc(0);
        }
      });
    });
    const socksPort = await listen(socks);
    const listenerPort = nextPort();
    const listener = startProxyListener({ id: "socks", port: listenerPort, mode: "proxy" }, [parseProxyEndpoint(`socks5h://127.0.0.1:${socksPort}`, true)]);
    await listener.ready();
    try {
      const response = await rawProxyRequest(listenerPort, "GET http://remote.example/media HTTP/1.1\r\nHost: remote.example\r\nConnection: close\r\n\r\n");
      expect(response).toContain("socks-ok");
      expect(connectHost).toBe("remote.example");
    } finally {
      await closeProxy(listener);
      for (const socket of sockets) socket.destroy();
      await close(socks);
    }
  });
});
