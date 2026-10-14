import { describe, expect, it } from "vitest";
import { occupancyPercent, statusCounts } from "./occupancy";

const rows = (...s: string[]) => s.map((status) => ({ status })) as { status: never }[];

describe("occupancy", () => {
  it("counts every status, including empty ones", () => {
    const c = statusCounts(rows("OCCUPIED", "OCCUPIED", "AVAILABLE", "OUT_OF_ORDER"));
    expect(c).toMatchObject({ OCCUPIED: 2, AVAILABLE: 1, OUT_OF_ORDER: 1, DUE_OUT: 0, CLEANING: 0, MAINTENANCE: 0, RESERVED: 0 });
  });
  it("leaves unsellable rooms out of the denominator", () => {
    // 2 occupied + 1 due out of 6 sellable (8 rooms minus 1 out of order and 1 maintenance) = 50%
    const c = statusCounts(rows("OCCUPIED", "OCCUPIED", "DUE_OUT", "AVAILABLE", "AVAILABLE", "RESERVED", "OUT_OF_ORDER", "MAINTENANCE"));
    expect(occupancyPercent(c)).toBe(50);
  });
  it("is zero when nothing can be sold", () => {
    expect(occupancyPercent(statusCounts([]))).toBe(0);
    expect(occupancyPercent(statusCounts(rows("OUT_OF_ORDER")))).toBe(0);
  });
});
