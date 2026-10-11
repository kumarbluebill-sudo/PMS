import { divRound } from "./gst";

export const BOOKING_SOURCES = ["WALK_IN", "PHONE", "DIRECT_WEBSITE", "TRAVEL_AGENT", "CORPORATE", "OTA", "OTHER"] as const;
/** Values written by earlier versions of the app stay readable and accepted. */
export const LEGACY_SOURCES = ["DIRECT", "EMAIL", "WEBSITE", "AGENT"] as const;
export const SOURCE_LABELS: Record<string, string> = {
  WALK_IN: "Walk-in", PHONE: "Phone", DIRECT_WEBSITE: "Direct website", TRAVEL_AGENT: "Travel agent", CORPORATE: "Corporate",
  OTA: "OTA / channel manager", OTHER: "Other", DIRECT: "Direct", EMAIL: "Email", WEBSITE: "Website", AGENT: "Agent",
};

/**
 * Nightly rate after a discount. A percentage is in basis points (1000 = 10%); a fixed amount is per night in paise.
 * Never negative. At most one kind of discount may be given.
 */
export function discountedRate(baseMinor: number, d: { percentBp?: number; amountMinor?: number } = {}): number {
  if (!Number.isInteger(baseMinor) || baseMinor < 0) throw new Error("Rate must be whole paise.");
  const pct = d.percentBp ?? 0;
  const amt = d.amountMinor ?? 0;
  if (pct > 0 && amt > 0) throw new Error("Give either a percentage or an amount discount, not both.");
  if (pct < 0 || pct > 10_000 || amt < 0 || !Number.isInteger(pct) || !Number.isInteger(amt)) throw new Error("Invalid discount.");
  if (pct > 0) return baseMinor - divRound(baseMinor * pct, 10_000);
  return Math.max(0, baseMinor - amt);
}

/** Indian-style mobile numbers and international numbers: 7 to 15 digits, optional leading +. */
export function normalizeMobile(raw: string): string | null {
  const t = raw.trim();
  if (!/^\+?[0-9][0-9 \-()]*$/.test(t)) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (t.startsWith("+") ? "+" : "") + digits;
}
