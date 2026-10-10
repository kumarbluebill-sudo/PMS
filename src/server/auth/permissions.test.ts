import { describe, expect, it } from "vitest";
import { assertPermission, ForbiddenError, roleHasPermission } from "./permissions";

describe("permission matrix", () => {
  it("restricts housekeeping to operational tasks", () => {
    expect(roleHasPermission("HOUSEKEEPING", "housekeeping.update")).toBe(true);
    expect(roleHasPermission("HOUSEKEEPING", "finance.view")).toBe(false);
    expect(roleHasPermission("HOUSEKEEPING", "guests.viewSensitive")).toBe(false);
  });
  it("platform roles hold no tenant data permissions by default", () => {
    expect(roleHasPermission("PLATFORM_SUPER_ADMIN", "reservations.view")).toBe(false);
  });
  it("honours extra grants for custom roles", () => {
    expect(roleHasPermission("HOUSEKEEPING", "audit.view", ["audit.view"])).toBe(true);
  });
  it("throws ForbiddenError when missing", () => {
    expect(() => assertPermission("AUDITOR", "reservations.create")).toThrow(ForbiddenError);
  });
});
