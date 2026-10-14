/** Normalises an Indian-default phone number to E.164, or null when it is not plausible. */
export function toE164(raw: string | null | undefined, defaultCountry = "91"): string | null {
  if (!raw) return null;
  let d = raw.replace(/[\s\-().]/g, "");
  if (d.startsWith("00")) d = `+${d.slice(2)}`;
  if (d.startsWith("+")) return /^\+[1-9]\d{9,14}$/.test(d) ? d : null;
  d = d.replace(/^0+/, "");
  if (/^[6-9]\d{9}$/.test(d)) return `+${defaultCountry}${d}`;
  if (/^\d{11,15}$/.test(d)) return `+${d}`;
  return null;
}

/** +919876543210 becomes +91******3210 so logs never hold a full number. */
export function maskPhone(e164: string): string {
  return e164.length <= 7 ? "***" : `${e164.slice(0, 3)}${"*".repeat(e164.length - 7)}${e164.slice(-4)}`;
}
