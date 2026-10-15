/**
 * Visual themes for invoices. A theme only chooses colours, type and spacing; it never touches amounts, tax lines
 * or the legal fields, which come from the same document data whatever the theme.
 */
export const INVOICE_THEMES = ["CLASSIC", "LUXURY", "MODERN", "RESORT", "COMPACT"] as const;
export type InvoiceTheme = (typeof INVOICE_THEMES)[number];
export const INVOICE_FONTS = ["HELVETICA", "TIMES", "COURIER"] as const;
export type InvoiceFont = (typeof INVOICE_FONTS)[number];

export const THEME_LABELS: Record<InvoiceTheme, { name: string; blurb: string }> = {
  CLASSIC: { name: "Classic professional", blurb: "White page, black type, plain tables." },
  LUXURY: { name: "Luxury hotel", blurb: "Navy and gold accents with a serif face." },
  MODERN: { name: "Modern corporate", blurb: "Teal accents and a clean corporate layout." },
  RESORT: { name: "Resort and boutique", blurb: "Restrained green accents and a spacious layout." },
  COMPACT: { name: "Compact", blurb: "Monochrome and tight, for small paper or plain printers." },
};

type Rgb = [number, number, number];
export type InvoiceStyle = {
  theme: InvoiceTheme;
  font: InvoiceFont;
  /** Dark enough for text on white. */
  accent: Rgb;
  /** Decorative rules and bars; may be light. */
  rule: Rgb;
  topBar: boolean;
  headFill: Rgb | null;
  baseSize: number;
  rowGap: number;
};

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const isHexColour = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
const luminance = ([r, g, b]: Rgb) => {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** Darkens a colour until it reads on white (contrast at least 4.5:1) so a pale accent still gives legible titles. */
export function legibleOnWhite(c: Rgb): Rgb {
  let out = c;
  for (let i = 0; i < 12 && 1.05 / (luminance(out) + 0.05) < 4.5; i++) out = [out[0] * 0.85, out[1] * 0.85, out[2] * 0.85];
  return out;
}

const BASE: Record<InvoiceTheme, Omit<InvoiceStyle, "theme" | "font">> = {
  CLASSIC: { accent: hex("#111111"), rule: hex("#999999"), topBar: false, headFill: null, baseSize: 9, rowGap: 3 },
  LUXURY: { accent: hex("#14213d"), rule: hex("#b8903a"), topBar: true, headFill: [0.96, 0.94, 0.88], baseSize: 9, rowGap: 4 },
  MODERN: { accent: hex("#0f5f5c"), rule: hex("#0f766e"), topBar: true, headFill: [0.9, 0.96, 0.95], baseSize: 9, rowGap: 3 },
  RESORT: { accent: hex("#3b5a43"), rule: hex("#8aa68f"), topBar: false, headFill: [0.95, 0.94, 0.9], baseSize: 9.5, rowGap: 7 },
  COMPACT: { accent: hex("#000000"), rule: hex("#000000"), topBar: false, headFill: null, baseSize: 8, rowGap: 1.5 },
};
const THEME_FONT: Record<InvoiceTheme, InvoiceFont> = { CLASSIC: "HELVETICA", LUXURY: "TIMES", MODERN: "HELVETICA", RESORT: "TIMES", COMPACT: "COURIER" };

/** Resolves a theme with the hotel's optional accent colour and font. Classic and compact stay monochrome. */
export function resolveInvoiceStyle(o: { theme?: string; accent?: string; font?: string } = {}): InvoiceStyle {
  const theme = (INVOICE_THEMES as readonly string[]).includes(o.theme ?? "") ? (o.theme as InvoiceTheme) : "CLASSIC";
  const base = BASE[theme];
  const custom = o.accent && isHexColour(o.accent) && theme !== "CLASSIC" && theme !== "COMPACT";
  const font = (INVOICE_FONTS as readonly string[]).includes(o.font ?? "") ? (o.font as InvoiceFont) : THEME_FONT[theme];
  return {
    theme, font, ...base,
    ...(custom && { accent: legibleOnWhite(hex(o.accent!)), rule: hex(o.accent!) }),
  };
}
