import { describe, expect, test } from "bun:test";
import { DEFAULT_ACTIVE_BROWSER_LEASES, MAX_ACTIVE_BROWSER_LEASES } from "@browser-fabric/contracts";
import { maxActiveBrowserLeasesFromEnvironment } from "./runtime";
import { BrowserScheduler } from "./scheduler";

describe("Fabric runtime browser capacity", () => {
  test("defaults to the reviewed default when unset or blank", () => {
    expect(maxActiveBrowserLeasesFromEnvironment({})).toBe(DEFAULT_ACTIVE_BROWSER_LEASES);
    expect(maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: "  " })).toBe(DEFAULT_ACTIVE_BROWSER_LEASES);
  });

  test("accepts every explicit cap from one to the contract maximum", () => {
    expect(maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: "1" })).toBe(1);
    expect(maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: " 6 " })).toBe(6);
    expect(maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: String(MAX_ACTIVE_BROWSER_LEASES) })).toBe(MAX_ACTIVE_BROWSER_LEASES);
  });

  test("fails closed for malformed or unsafe deployment caps", () => {
    for (const value of ["0", String(MAX_ACTIVE_BROWSER_LEASES + 1), "1.5", "two", "-1", "1e1", "0x6"]) {
      expect(() => maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: value })).toThrow(`FABRIC_MAX_ACTIVE_BROWSER_LEASES must be an integer from 1 to ${MAX_ACTIVE_BROWSER_LEASES}`);
    }
  });

  test("the scheduler enforces the same bound", () => {
    expect(() => new BrowserScheduler({ maxActiveBrowserLeases: MAX_ACTIVE_BROWSER_LEASES })).not.toThrow();
    for (const value of [0, MAX_ACTIVE_BROWSER_LEASES + 1, 2.5]) {
      expect(() => new BrowserScheduler({ maxActiveBrowserLeases: value })).toThrow("global browser capacity");
    }
  });
});
