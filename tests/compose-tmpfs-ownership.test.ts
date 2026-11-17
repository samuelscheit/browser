import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { tmpfsOwnershipViolations } from "../scripts/compose-tmpfs-ownership";

const composePath = new URL("../deploy/compose/compose.yml", import.meta.url);

function service(body: string): string {
  return `services:\n  probe:\n    image: example@sha256:${"a".repeat(64)}\n${body}`;
}

describe("Compose tmpfs ownership", () => {
  test("the checked-in deployment gives every non-root service its own restricted tmpfs", async () => {
    expect(tmpfsOwnershipViolations(await readFile(composePath, "utf8"))).toEqual([]);
  });

  test("stripping the tmpfs owners makes every non-root service of the deployment a violation", async () => {
    // Docker mounts tmpfs as root:root: without uid=/gid= a non-root service has no writable /tmp.
    const stripped = (await readFile(composePath, "utf8")).replaceAll(/,uid=\d+,gid=\d+$/gm, "");
    const unowned = tmpfsOwnershipViolations(stripped)
      .filter((violation) => violation.includes("must be owned by its service user 10001:10001"))
      .map((violation) => violation.split(" ")[0])
      .sort();
    expect(unowned).toEqual([
      "fabric-api", "fabric-cdp-gateway", "fabric-egress-sidecar", "fabric-input-broker", "fabric-media-playback-gateway",
      "fabric-observability", "fabric-provisioner", "fabric-scheduler", "fabric-worker-chromium", "fabric-worker-media",
      "fabric-worker-patchright", "fabric-worker-rebrowser",
    ]);
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
