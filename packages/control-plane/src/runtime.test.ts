import { describe, expect, test } from "bun:test";
import { maxActiveBrowserLeasesFromEnvironment } from "./runtime";

describe("Fabric runtime browser capacity", () => {
  test("defaults to the reviewed safe maximum", () => {
    expect(maxActiveBrowserLeasesFromEnvironment({})).toBe(4);
  });

  test("accepts a conservative explicit deployment cap", () => {
    expect(maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: "2" })).toBe(2);
  });

  test("fails closed for malformed or unsafe deployment caps", () => {
    for (const value of ["0", "5", "1.5", "two", "-1"]) {
      expect(() => maxActiveBrowserLeasesFromEnvironment({ FABRIC_MAX_ACTIVE_BROWSER_LEASES: value })).toThrow("FABRIC_MAX_ACTIVE_BROWSER_LEASES");
    }
  });
});
