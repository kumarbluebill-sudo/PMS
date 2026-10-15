/** Pure layout helpers for the room rack. Dates are YYYY-MM-DD and nights run from arrival up to (not including) departure. */
const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);

export const RACK_RANGES = [7, 14, 30] as const;

/** Where a stay sits in a window of `days` columns starting at `start`; null when it does not touch the window. */
export function barPlacement(arrival: string, departure: string, start: string, days: number) {
  const first = Math.max(0, diffDays(start, arrival));
  const last = Math.min(days, diffDays(start, departure)); // exclusive
  if (last <= first) return null;
  return {
    col: first, span: last - first,
    cutLeft: diffDays(start, arrival) < 0,
    cutRight: diffDays(start, departure) > days,
  };
}

/** Columns where the stay arrives or departs inside the window. */
export function stayEdges(arrival: string, departure: string, start: string, days: number) {
  const a = diffDays(start, arrival), d = diffDays(start, departure);
  return { arrivalCol: a >= 0 && a < days ? a : null, departureCol: d >= 0 && d < days ? d : null };
}
