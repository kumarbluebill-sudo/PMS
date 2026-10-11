import { describe, expect, it } from "vitest";
import { isSessionExpired } from "./session";

describe("isSessionExpired", () => {
  const t0 = Date.parse("2026-10-12T10:00:00Z");
  it("expires exactly after the limit", () => {
    expect(isSessionExpired(t0, 30, t0 + 30 * 60_000)).toBe(false);
    expect(isSessionExpired(t0, 30, t0 + 30 * 60_000 + 1)).toBe(true);
  });
  it("ignores tokens without a sign-in time", () => {
    expect(isSessionExpired(undefined, 15, t0 + 10 * 86_400_000)).toBe(false);
  });
});
