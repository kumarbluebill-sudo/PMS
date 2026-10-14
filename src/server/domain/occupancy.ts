import { DISPLAY_STATUSES, type DisplayStatus } from "./roomStatus";

export type StatusCounts = Record<DisplayStatus, number>;

/** How many rooms are in each display status (every status is present, zero when empty). */
export function statusCounts(rows: readonly { status: DisplayStatus }[]): StatusCounts {
  const out = Object.fromEntries(DISPLAY_STATUSES.map((s) => [s, 0])) as StatusCounts;
  for (const r of rows) out[r.status] += 1;
  return out;
}

/**
 * Occupancy = rooms with a guest in them / rooms that could be sold today.
 * Rooms that are out of order or under maintenance are not sellable, so they are left out of the denominator.
 */
export function occupancyPercent(c: StatusCounts): number {
  const sellable = DISPLAY_STATUSES.reduce((n, s) => n + c[s], 0) - c.OUT_OF_ORDER - c.MAINTENANCE;
  if (sellable <= 0) return 0;
  return Math.round(((c.OCCUPIED + c.DUE_OUT) / sellable) * 100);
}
