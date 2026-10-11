import { describe, expect, it } from "vitest";
import { initialComplaintStatus, parseFeedbackToken, roundAvg, summarizeDistribution } from "./feedback";

describe("ratings", () => {
  it("averages exactly from a distribution", () => {
    expect(summarizeDistribution({ 5: 2, 4: 1, 1: 1 })).toEqual({ count: 4, average: 3.75, positive: 3, low: 1 });
    expect(summarizeDistribution({ 1: 1, 2: 1, 3: 1 })).toEqual({ count: 3, average: 2, positive: 0, low: 2 });
    expect(summarizeDistribution({})).toEqual({ count: 0, average: null, positive: 0, low: 0 });
  });
  it("rounds to two decimals and handles empty", () => {
    expect(roundAvg(3.14159)).toBe(3.14);
    expect(roundAvg(null)).toBeNull();
    expect(summarizeDistribution({ 5: 2, 4: 1 }).average).toBe(4.67);
  });
  it("low ratings open a complaint", () => {
    expect(initialComplaintStatus(1)).toBe("OPEN");
    expect(initialComplaintStatus(2)).toBe("OPEN");
    expect(initialComplaintStatus(3)).toBe("NONE");
    expect(initialComplaintStatus(5)).toBe("NONE");
  });
});

describe("feedback tokens", () => {
  const tenant = "0b0c4a1e-3f55-4c1b-8a31-1d6f2a9c7e10";
  const rand = "A".repeat(43);
  it("extracts the tenant from a well-formed token", () => {
    expect(parseFeedbackToken(`${tenant}.${rand}`)).toEqual({ tenantId: tenant });
  });
  it("rejects anything else", () => {
    for (const bad of ["", "abc", `${tenant}`, `${tenant}.short`, `${tenant}.${rand}!`, `not-a-uuid.${rand}`, `${tenant}.${rand}.extra`]) {
      expect(parseFeedbackToken(bad)).toBeNull();
    }
  });
});
