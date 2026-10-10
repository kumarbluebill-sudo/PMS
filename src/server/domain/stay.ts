/**
 * Stay dates are calendar dates (YYYY-MM-DD) in the property's timezone.
 * Intervals are half-open: [arrival, departure). The departure date is NOT
 * an occupied night.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtcDay(date: string): number {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`Invalid date: ${date}`);
  }
  return t / 86_400_000;
}

export function nightsBetween(arrival: string, departure: string): number {
  const n = toUtcDay(departure) - toUtcDay(arrival);
  if (n < 1) throw new Error("Departure must be after arrival.");
  return n;
}

export function stayNights(arrival: string, departure: string): string[] {
  const n = nightsBetween(arrival, departure);
  const start = toUtcDay(arrival);
  return Array.from({ length: n }, (_, i) =>
    new Date((start + i) * 86_400_000).toISOString().slice(0, 10),
  );
}

export function rangesOverlap(
  aArrival: string,
  aDeparture: string,
  bArrival: string,
  bDeparture: string,
): boolean {
  return toUtcDay(aArrival) < toUtcDay(bDeparture) && toUtcDay(bArrival) < toUtcDay(aDeparture);
}

export const RESERVATION_STATUSES = [
  "INQUIRY",
  "TENTATIVE",
  "CONFIRMED",
  "CHECKED_IN",
  "CHECKED_OUT",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  INQUIRY: ["TENTATIVE", "CONFIRMED", "CANCELLED"],
  TENTATIVE: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["CHECKED_OUT"],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** Statuses whose room assignment blocks inventory. */
export const ACTIVE_STATUSES: readonly ReservationStatus[] = ["TENTATIVE", "CONFIRMED", "CHECKED_IN"];

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: ReservationStatus, to: ReservationStatus) {
    super(`A reservation cannot move from ${from} to ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
