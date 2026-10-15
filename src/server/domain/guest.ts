/**
 * Phone matching for guest lookup. A phone is stored as the user typed it (keeping its country code and spacing for
 * display); `phoneKey` is its last 10 digits, so "+91 98765-43210", "098765 43210" and "9876543210" all find the
 * same guest. Short numbers (4 to 9 digits) match as a fragment.
 */
export const digitsOf = (raw: string) => raw.replace(/\D/g, "");

/** The stored key: last 10 digits, or null when the number is too short to identify anyone. */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = digitsOf(raw ?? "");
  return d.length >= 4 ? d.slice(-10) : null;
}

export type PhoneQuery = { kind: "exact"; key: string } | { kind: "fragment"; digits: string } | null;

/** How a search text should be matched against phone keys, or null when it does not look like a number. */
export function phoneQuery(q: string): PhoneQuery {
  const t = q.trim();
  if (!/^\+?[\d\s\-()]+$/.test(t)) return null;
  const d = digitsOf(t);
  if (d.length < 4) return null;
  return d.length >= 10 ? { kind: "exact", key: d.slice(-10) } : { kind: "fragment", digits: d };
}

/** Last four digits only, for audit entries and messages that must not carry the whole number. */
export function maskPhone(raw: string | null | undefined): string | null {
  const d = digitsOf(raw ?? "");
  return d.length ? `…${d.slice(-4)}` : null;
}

export function maskEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const [user, host] = raw.split("@");
  return host ? `${user.slice(0, 1)}…@${host}` : null;
}
