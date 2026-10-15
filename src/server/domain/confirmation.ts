/**
 * The checklist shown before a held (pending) booking is confirmed. A blocker stops confirmation; a warning is shown
 * but does not stop it, because hotels confirm bookings before the deposit arrives or while the policy is still being
 * written. Pure: the service gathers the facts and this decides.
 */
export type CheckLevel = "BLOCKER" | "WARNING";
export type CheckItem = { key: string; label: string; ok: boolean; level: CheckLevel; detail: string };

export type ChecklistFacts = {
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  arrival: string;
  departure: string;
  today: string;
  adults: number;
  children: number;
  maxAdults: number;
  maxChildren: number;
  categoryName: string;
  categoryActive: boolean;
  roomNumber: string | null;
  hasRateSnapshot: boolean;
  totalMinor: number;
  /** Null when the viewer cannot see billing, so money items are left out rather than guessed. */
  paidMinor: number | null;
  depositRequiredMinor: number;
  cancellationPolicy: string;
};

const inr = (m: number) => `₹${(m / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

export function confirmationChecklist(f: ChecklistFacts): { items: CheckItem[]; blockers: CheckItem[]; warnings: CheckItem[]; canConfirm: boolean } {
  const items: CheckItem[] = [];
  const add = (key: string, label: string, ok: boolean, level: CheckLevel, good: string, bad: string) => items.push({ key, label, ok, level, detail: ok ? good : bad });

  add("guest", "Guest name", f.guestName.trim().length > 0, "BLOCKER", f.guestName, "The booking has no guest name.");
  add("contact", "Guest contact", !!(f.guestPhone || f.guestEmail), "WARNING", [f.guestPhone, f.guestEmail].filter(Boolean).join(" · "), "No mobile number or email, so the confirmation cannot be sent.");
  add("dates", "Arrival and departure", f.departure > f.arrival, "BLOCKER", `${f.arrival} to ${f.departure}`, "Departure must be after arrival.");
  if (f.departure > f.arrival) add("future", "Arrival date", f.arrival >= f.today, "WARNING", "Not in the past", `Arrival ${f.arrival} is before today.`);
  add("guests", "Number of guests", f.adults >= 1 && f.adults <= f.maxAdults && f.children <= f.maxChildren, "BLOCKER", `${f.adults} adult(s), ${f.children} child(ren)`, `${f.categoryName} takes up to ${f.maxAdults} adult(s) and ${f.maxChildren} child(ren) per room.`);
  add("category", "Room category", f.categoryActive, "BLOCKER", f.categoryName, `${f.categoryName} is inactive and cannot be confirmed for new stays.`);
  add("room", "Room held", !!f.roomNumber, "BLOCKER", `Room ${f.roomNumber}`, "No room is held for these dates. Assign a room first.");
  add("rate", "Rate and nightly prices", f.hasRateSnapshot, "WARNING", "Frozen at booking", "This older booking has no night-by-night rates saved; the agreed rate is used.");
  add("total", "Total booking value", f.totalMinor > 0, "WARNING", inr(f.totalMinor), "The booking total is zero.");
  if (f.paidMinor !== null && f.depositRequiredMinor > 0) {
    add("deposit", "Deposit", f.paidMinor >= f.depositRequiredMinor, "WARNING", `${inr(f.paidMinor)} received of ${inr(f.depositRequiredMinor)} requested`, `${inr(f.paidMinor)} received; ${inr(f.depositRequiredMinor)} requested by the hotel's policy.`);
  }
  add("policy", "Cancellation policy", f.cancellationPolicy.trim().length > 0, "WARNING", "Set for this property", "No cancellation policy is set, so none will appear on the confirmation.");

  const blockers = items.filter((i) => !i.ok && i.level === "BLOCKER");
  const warnings = items.filter((i) => !i.ok && i.level === "WARNING");
  return { items, blockers, warnings, canConfirm: blockers.length === 0 };
}
