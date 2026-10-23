import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { tmpfsOwnershipViolations } from "../scripts/compose-tmpfs-ownership";

const composePath = new URL("../deploy/compose/browser-fabric.compose.yml", import.meta.url);

function service(body: string): string {
  return `services:\n  probe:\n    image: example@sha256:${"a".repeat(64)}\n${body}`;
}

describe("Compose tmpfs ownership", () => {
  test("the checked-in deployment gives every non-root service its own restricted tmpfs", async () => {
    expect(tmpfsOwnershipViolations(await readFile(composePath, "utf8"))).toEqual([]);
  });

  test("the pre-fix deployment is rejected for exactly the non-root services that had no writable /tmp", async () => {
    // Rebuild what production ran when the Social worker's Playwright driver failed with EACCES
    // creating /tmp/playwright-artifacts-*: no tmpfs owners and implicit image-default users.
    const original = (await readFile(composePath, "utf8"))
      .replaceAll(/,uid=\d+,gid=\d+$/gm, "")
      .replace(/^    # Pins the image default user[^\n]*\n    user: '10001:10001'\n/m, "")
      .replace(/^    # The upstream Companion image runs as root[^\n]*\n    user: '0:0'\n/m, "");
    const violations = tmpfsOwnershipViolations(original);
    const unowned = violations.filter((violation) => violation.includes("must be owned by its service user 10001:10001")).map((violation) => violation.split(" ")[0]).sort();
    expect(unowned).toEqual([
      "fabric-api", "fabric-cdp-gateway", "fabric-cdp-relay-chat", "fabric-cdp-relay-reporting", "fabric-egress-sidecar",
      "fabric-input-broker", "fabric-media-playback-gateway", "fabric-provisioner", "fabric-scheduler", "fabric-companion-adapter",
      "fabric-worker-chromium", "fabric-worker-media", "fabric-worker-patchright", "fabric-worker-rebrowser", "fabric-worker-companion",
      "fabric-worker-social",
    ]);
    // Image-default users (observability's 10001, Companion's root) were implicit before the fix.
    expect(violations).toContain("fabric-observability has a restricted tmpfs and must declare an explicit numeric user");
    expect(violations).toContain("fabric-companion has a restricted tmpfs and must declare an explicit numeric user");
    expect(violations).toHaveLength(18);
  });

  test("every restricted mount of a non-root service is checked, including /data", () => {
    expect(tmpfsOwnershipViolations(service("    user: '10001:10001'\n    tmpfs:\n      - /tmp:rw,mode=1770,uid=10001,gid=10001\n      - /data:rw,noexec,mode=1770\n"))).toEqual([
      "probe tmpfs /data must be owned by its service user 10001:10001",
    ]);
  });

  test("a mismatched owner is rejected", () => {
    expect(tmpfsOwnershipViolations(service("    user: '10001:10001'\n    tmpfs:\n      - /tmp:rw,mode=1770,uid=10001,gid=0\n"))).toEqual([
      "probe tmpfs /tmp must be owned by its service user 10001:10001",
    ]);
    expect(tmpfsOwnershipViolations(service("    user: '10001'\n    tmpfs:\n      - /tmp:rw,mode=0700,uid=10001,gid=10001\n"))).toEqual([]);
  });

  test("root services and world-writable tmpfs mounts need no owner", () => {
    expect(tmpfsOwnershipViolations(service("    user: '0:0'\n    tmpfs:\n      - /tmp:rw,mode=1770\n"))).toEqual([]);
    expect(tmpfsOwnershipViolations(service("    tmpfs:\n      - /tmp:rw,noexec,mode=1777\n"))).toEqual([]);
    expect(tmpfsOwnershipViolations(service("    tmpfs: /tmp\n"))).toEqual([]);
  });

  test("restricted tmpfs mounts require an explicit numeric user", () => {
    expect(tmpfsOwnershipViolations(service("    tmpfs:\n      - /tmp:rw,mode=1770\n"))).toEqual([
      "probe has a restricted tmpfs and must declare an explicit numeric user",
    ]);
    expect(tmpfsOwnershipViolations(service("    user: fabric-tor:fabric-tor\n    tmpfs:\n      - /tmp:rw,mode=1770\n"))).toEqual([
      "probe has a restricted tmpfs and must declare an explicit numeric user",
    ]);
  });

  test("bind and named volumes are not mistaken for tmpfs, but long-syntax tmpfs is refused", () => {
    expect(tmpfsOwnershipViolations(service("    user: '10001:10001'\n    volumes:\n      - fabric_data:/data\n      - type: bind\n        source: ./config.yml\n        target: /etc/config.yml\n"))).toEqual([]);
    expect(tmpfsOwnershipViolations(service("    user: '10001:10001'\n    volumes:\n      - type: tmpfs\n        target: /tmp\n"))).toEqual([
      "probe must declare tmpfs mounts with the short syntax so uid/gid ownership is explicit",
    ]);
  });
});
