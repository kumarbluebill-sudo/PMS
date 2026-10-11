/**
 * Room board status. Physical state (out of order, maintenance, housekeeping, occupancy) is derived
 * separately from booking state; a room reserved for a later date is still physically available today.
 */
export const DISPLAY_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "OCCUPIED",
  "DUE_OUT",
  "CLEANING",
  "MAINTENANCE",
  "OUT_OF_ORDER",
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/** Label, icon and Tailwind classes. Colour is never the only signal: every status has a text label and an icon. */
export const STATUS_META: Record<DisplayStatus, { label: string; icon: string; chip: string; cell: string; hint: string }> = {
  AVAILABLE: { label: "Available", icon: "✓", chip: "bg-green-100 text-green-900 border-green-300", cell: "border-green-400 bg-green-50", hint: "Ready for sale, not occupied" },
  OCCUPIED: { label: "Occupied", icon: "●", chip: "bg-blue-100 text-blue-900 border-blue-300", cell: "border-blue-400 bg-blue-50", hint: "Guest is in the room" },
  DUE_OUT: { label: "Checkout due", icon: "⏰", chip: "bg-orange-100 text-orange-900 border-orange-300", cell: "border-orange-400 bg-orange-50", hint: "Checkout date reached, not yet checked out" },
  CLEANING: { label: "Cleaning required", icon: "🧹", chip: "bg-slate-200 text-slate-900 border-slate-400", cell: "border-slate-400 bg-slate-100", hint: "Stay ended, room not ready for sale" },
  OUT_OF_ORDER: { label: "Out of order", icon: "⛔", chip: "bg-red-100 text-red-900 border-red-300", cell: "border-red-400 bg-red-50", hint: "Cannot be sold: recorded operational issue" },
  MAINTENANCE: { label: "Maintenance", icon: "🔧", chip: "bg-purple-100 text-purple-900 border-purple-300", cell: "border-purple-400 bg-purple-50", hint: "Blocked for a maintenance task" },
  RESERVED: { label: "Reserved", icon: "📅", chip: "bg-yellow-100 text-yellow-900 border-yellow-400", cell: "border-yellow-400 bg-yellow-50", hint: "Upcoming confirmed booking, not occupied" },
};

export type StatusInput = {
  outOfOrder: boolean;
  /** An unresolved maintenance request that blocks the room from sale. */
  maintenanceBlock: boolean;
  housekeeping: string;
  /** A guest checked in to this room on the viewed date. */
  inHouse?: { departure: string } | null;
  /** A guest expected in this room on the viewed date (projection for non-today dates). */
  expectedStay?: { arrival: string; departure: string } | null;
  /** The next confirmed booking arriving on or after the viewed date. */
  upcoming?: { arrival: string } | null;
  /** The viewed date, YYYY-MM-DD, in the property's timezone. */
  date: string;
  /** True when the viewed date is today; housekeeping state only applies to the live board. */
  live: boolean;
};

/** Precedence: out of order > maintenance > occupied/due out > cleaning > reserved > available. */
export function deriveRoomStatus(i: StatusInput): DisplayStatus {
  if (i.outOfOrder) return "OUT_OF_ORDER";
  if (i.maintenanceBlock) return "MAINTENANCE";
  const stay = i.live ? i.inHouse : i.expectedStay;
  if (stay) return stay.departure <= i.date ? "DUE_OUT" : "OCCUPIED";
  if (i.live && (i.housekeeping === "DIRTY" || i.housekeeping === "CLEANING")) return "CLEANING";
  if (i.upcoming) return "RESERVED";
  return "AVAILABLE";
}

/** Statuses that can be sold (physically free now). Used for the "Available Rooms" card. */
export const SELLABLE: ReadonlySet<DisplayStatus> = new Set<DisplayStatus>(["AVAILABLE", "RESERVED"]);

/** Local calendar date (YYYY-MM-DD) in an IANA timezone. */
export function dateInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function paymentStatusOf(billed: number, paid: number, refunded: number, balance: number): string {
  if (refunded > 0 && paid - refunded <= 0) return "REFUNDED";
  if (refunded > 0) return "PARTIALLY_REFUNDED";
  if (billed > 0 && paid === 0) return "UNPAID";
  if (balance > 0) return "PARTIALLY_PAID";
  return paid > 0 ? "PAID" : "UNPAID";
}
