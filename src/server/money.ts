import { AppError } from "@/server/errors";

/** "1,234.50" -> 123450 using integer maths only (never floating point). Max 9 digits of rupees. */
export function rupeesToMinor(input: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ""));
  if (!m) throw new AppError("VALIDATION", "Enter an amount like 1250 or 1250.50.");
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

export const formatInr = (minor: number) => {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100).toLocaleString("en-IN");
  return `${sign}₹${rupees}.${String(abs % 100).padStart(2, "0")}`;
};
