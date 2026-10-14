/** Pure hotel KPI rules, shared by the analytics service and its tests. Money is integer paise throughout. */

export type DayKind = "ACTUAL" | "LIVE" | "FORECAST";

/** Past nights are actuals, tonight is live, later nights are forecasts (estimates, not results). */
export function dayKind(date: string, today: string): DayKind {
  return date < today ? "ACTUAL" : date === today ? "LIVE" : "FORECAST";
}

/**
 * Which reservation statuses count as a room being sold/occupied on a night.
 * Past nights: guests who actually stayed. Tonight: guests in house. Later nights: valid bookings (estimate).
 * Cancelled, no-show, tentative and inquiry reservations never count.
 */
export function countedStatuses(kind: DayKind): readonly string[] {
  if (kind === "ACTUAL") return ["CHECKED_IN", "CHECKED_OUT"];
  if (kind === "LIVE") return ["CHECKED_IN"];
  return ["CHECKED_IN", "CONFIRMED"];
}

/** Occupancy % = occupied sellable rooms / sellable rooms. Zero when nothing can be sold. */
export function occupancyPct(sold: number, sellable: number): number {
  return sellable > 0 ? Math.round((sold / sellable) * 1000) / 10 : 0;
}

/** ARR = room revenue / rooms sold (paise, rounded). Null when no rooms were sold, so the screen can say "no data". */
export function arr(revenueMinor: number, sold: number): number | null {
  return sold > 0 ? Math.round(revenueMinor / sold) : null;
}

/** RevPAR = room revenue / available sellable room-nights (paise, rounded). */
export function revpar(revenueMinor: number, sellableNights: number): number | null {
  return sellableNights > 0 ? Math.round(revenueMinor / sellableNights) : null;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/**
 * A confirmed reservation is a no-show *candidate* (for staff review, never automatic) when its arrival date has
 * passed, or it is today and the property's configured cutoff time has been reached.
 */
export function isNoShowCandidate(arrival: string, today: string, nowHHMM: string, cutoffHHMM: string): boolean {
  if (arrival < today) return true;
  return arrival === today && toMinutes(nowHHMM) >= toMinutes(cutoffHHMM);
}

export type Severity = "CRITICAL" | "WARNING" | "INFO";
export const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

export type Alert = {
  /** Stable key (kind + entity) so an acknowledgement sticks to the same issue. */
  key: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  href: string;
  /** Set when a staff member has acknowledged or resolved it. */
  ack?: { status: "ACKNOWLEDGED" | "RESOLVED"; by: string; at: string; note: string | null };
};

export function sortAlerts<T extends { severity: Severity; title: string }>(a: T[]): T[] {
  return a.slice().sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.title.localeCompare(y.title));
}

/** Local HH:MM in an IANA zone. */
export function timeInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
}
