import { z } from "zod";
import { INVOICE_FONTS, INVOICE_THEMES, THEME_LABELS, isHexColour } from "./invoiceTheme";
import type { Permission } from "@/server/auth/permissions";
import { BOOKING_SOURCES } from "./quote";
import { ISSUE_CATEGORIES, CATEGORY_LABELS } from "./roomBlock";
import { DISPLAY_STATUSES, STATUS_META, type DisplayStatus } from "./roomStatus";

export const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "COMPANY_CREDIT", "OTHER"] as const;
export const PALETTE_KEYS = ["green", "blue", "orange", "slate", "red", "purple", "yellow", "teal", "pink"] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

export type Control = "text" | "textarea" | "number" | "checkbox" | "select" | "multi" | "secret";
export type Group = "general" | "reservations" | "rooms" | "billing" | "security" | "notifications" | "reports" | "backup";

export type SettingDef<S extends z.ZodType = z.ZodType> = {
  scope: "PROPERTY" | "TENANT";
  perm: Permission;
  group: Group;
  label: string;
  help?: string;
  control: Control;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  secret?: boolean;
  schema: S;
  default: z.output<S>;
};

const def = <S extends z.ZodType>(d: SettingDef<S>) => d;
const opts = <T extends string>(vals: readonly T[], labels?: Record<string, string>) => vals.map((v) => ({ value: v, label: labels?.[v] ?? v.replaceAll("_", " ").toLowerCase() }));
const text = (max: number) => z.string().trim().max(max);
const httpsUrl = z.string().trim().max(300).refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "Enter an https:// address.");
const emailOrEmpty = z.string().trim().max(200).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address.");

/** Every setting the app understands. Anything not listed here cannot be stored. */
export const DEFS = {
  // General
  "general.phone": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Phone", control: "text", schema: text(30), default: "" }),
  "general.email": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Email", control: "text", schema: emailOrEmpty, default: "" }),
  "general.website": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Website", control: "text", help: "Must start with https://", schema: httpsUrl, default: "" }),
  "general.logoUrl": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Logo address", control: "text", help: "An https:// link to your logo image. File upload is not available yet.", schema: httpsUrl, default: "" }),
  "general.dateFormat": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Date format (saved preference)", control: "select", help: "Saved for printed documents; screens currently show YYYY-MM-DD.", options: opts(["DD MMM YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]), schema: z.enum(["DD MMM YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]), default: "DD MMM YYYY" }),
  "general.language": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Language", control: "select", options: [{ value: "en", label: "English" }], schema: z.enum(["en"]), default: "en" as const }),
  "general.bookingPolicies": def({ scope: "PROPERTY", perm: "settings.manage", group: "general", label: "Booking policies", control: "textarea", help: "Printed on booking confirmations.", schema: text(2000), default: "" }),

  // Reservations
  "reservation.referencePrefix": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Booking reference prefix", control: "text", help: "2 to 6 capital letters. Applies to new bookings only.", schema: z.string().trim().regex(/^[A-Z]{2,6}$/, "Use 2 to 6 capital letters."), default: "MK" }),
  "reservation.minNights": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Minimum stay (nights)", control: "number", min: 1, max: 365, schema: z.number().int().min(1).max(365), default: 1 }),
  "reservation.maxNights": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Maximum stay (nights)", control: "number", min: 1, max: 365, schema: z.number().int().min(1).max(365), default: 365 }),
  "reservation.depositPercent": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Deposit required (% of the estimate)", control: "number", min: 0, max: 100, help: "Shown on the booking form and confirmation. Bookings are not blocked if it is not met.", schema: z.number().int().min(0).max(100), default: 0 }),
  "reservation.enabledSources": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Booking sources in use", control: "multi", options: opts(BOOKING_SOURCES), schema: z.array(z.enum(BOOKING_SOURCES)).min(1, "Keep at least one booking source."), default: [...BOOKING_SOURCES] }),
  "reservation.repriceOnChange": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "When a booking's dates or guests change", control: "select", help: "Keep the rates the guest was quoted, or price the changed stay from today's rates and plans. The new total is always shown before saving.", options: [{ value: "KEEP_RATE", label: "Keep the booked rates" }, { value: "CURRENT_RATE", label: "Use today's rates" }], schema: z.enum(["KEEP_RATE", "CURRENT_RATE"]), default: "KEEP_RATE" as const }),
  "reservation.cancellationPolicy": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Cancellation policy", control: "textarea", schema: text(2000), default: "" }),
  "reservation.noShowRule": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "No-show rule", control: "textarea", schema: text(1000), default: "" }),
  "reservation.childPolicy": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Child policy", control: "textarea", help: "Extra-person rates are set on each room type.", schema: text(1000), default: "" }),
  "reservation.confirmationHeader": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Confirmation: opening text", control: "textarea", schema: text(1000), default: "" }),
  "reservation.confirmationFooter": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Confirmation: closing text", control: "textarea", schema: text(1000), default: "" }),

  // Front office
  "frontoffice.noShowCutoffTime": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "No-show review time (HH:MM)", control: "text", help: "From this time on the arrival date, confirmed reservations that have not arrived are listed for staff to review. Nothing is marked a no-show automatically.", schema: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, for example 22:00."), default: "22:00" }),
  "frontoffice.requireIdAtCheckin": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Require ID to be verified before check-in", control: "checkbox", help: "When on, check-in from the check-in screen is blocked until a staff member records that ID was verified.", schema: z.boolean(), default: false }),
  "frontoffice.dashboardRefreshSeconds": def({ scope: "PROPERTY", perm: "settings.manage", group: "reservations", label: "Refresh the room board every (seconds, 0 = off)", control: "number", min: 0, max: 600, schema: z.number().int().min(0).max(600), default: 0 }),

  // Rooms and housekeeping
  "rooms.statusLabels": def({
    scope: "PROPERTY", perm: "settings.manage", group: "rooms", label: "Room status labels and colours", control: "text",
    schema: z.partialRecord(z.enum(DISPLAY_STATUSES), z.object({ label: z.string().trim().min(1).max(30).optional(), color: z.enum(PALETTE_KEYS).optional() })),
    default: {} as Partial<Record<(typeof DISPLAY_STATUSES)[number], { label?: string; color?: PaletteKey }>>,
  }),
  "rooms.maintenanceRequireApproval": def({ scope: "PROPERTY", perm: "settings.manage", group: "rooms", label: "Blocks raised by staff without approval authority need a manager's confirmation", control: "checkbox", schema: z.boolean(), default: true }),
  "rooms.maintenanceCategories": def({ scope: "PROPERTY", perm: "settings.manage", group: "rooms", label: "Maintenance categories in use", control: "multi", options: ISSUE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })), schema: z.array(z.enum(ISSUE_CATEGORIES)).min(1, "Keep at least one category."), default: [...ISSUE_CATEGORIES] }),
  "rooms.housekeepingCategories": def({ scope: "PROPERTY", perm: "settings.manage", group: "rooms", label: "Housekeeping task types (one per line)", control: "textarea", help: "Saved list; housekeeping tasks currently use the built-in departure / stayover / priority types.", schema: z.array(z.string().trim().min(1).max(40)).max(20), default: ["Departure clean", "Stayover clean", "Deep clean", "Turn-down"] }),

  // Billing
  "billing.invoiceTerms": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Invoice terms", control: "textarea", help: "Printed on invoices and in the PDF.", schema: text(1500), default: "" }),
  "billing.invoiceNotes": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Invoice footer note", control: "textarea", schema: text(500), default: "" }),
  "billing.receiptFooter": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Payment receipt footer", control: "textarea", schema: text(500), default: "" }),
  "billing.docHeader": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Document header line", control: "text", help: "Shown under the hotel name on invoices and receipts, e.g. a tagline or registration number.", schema: text(200), default: "" }),
  "billing.paymentInstructions": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Payment instructions", control: "textarea", help: "Bank or UPI details printed on invoices.", schema: text(500), default: "" }),
  "billing.signatureLabel": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Signature line label", control: "text", help: "Printed above a signature line, e.g. Authorised signatory.", schema: text(60), default: "" }),
  "billing.receiptLayout": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Receipt PDF layout", control: "select", options: [{ value: "A4", label: "A4 page" }, { value: "THERMAL", label: "Receipt printer (80 mm)" }], schema: z.enum(["A4", "THERMAL"]), default: "A4" as const }),
  "billing.theme": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Invoice theme", control: "select", help: "Changes how invoices look, never their amounts or tax lines. Preview it under Invoice design.", options: INVOICE_THEMES.map((t) => ({ value: t, label: THEME_LABELS[t].name })), schema: z.enum(INVOICE_THEMES), default: "CLASSIC" as const }),
  "billing.accentColor": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Invoice accent colour", control: "text", help: "Optional, e.g. #0f766e. Used by the coloured themes only; leave blank for the theme colour.", schema: z.string().trim().refine((v) => v === "" || isHexColour(v), "Use a colour like #0f766e."), default: "" }),
  "billing.font": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Invoice typeface", control: "select", options: [{ value: "", label: "Theme default" }, { value: "HELVETICA", label: "Helvetica (sans-serif)" }, { value: "TIMES", label: "Times (serif)" }, { value: "COURIER", label: "Courier (monospace)" }], schema: z.enum(["", ...INVOICE_FONTS]), default: "" as const }),
  "billing.enabledPaymentMethods": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Payment methods in use", control: "multi", options: opts(PAYMENT_METHODS), schema: z.array(z.enum(PAYMENT_METHODS)).min(1, "Keep at least one payment method."), default: [...PAYMENT_METHODS] }),
  "billing.taxInclusiveDefault": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Charges entered include GST by default", control: "checkbox", schema: z.boolean(), default: false }),
  "billing.maxDiscountPercent": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Largest discount allowed (%)", control: "number", min: 0, max: 100, help: "Applies to booking discounts and to discounts posted on a folio.", schema: z.number().int().min(0).max(100), default: 100 }),
  "billing.refundApprovalLimitMinor": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Refunds above this amount need a manager (₹, 0 = no limit)", control: "number", min: 0, schema: z.number().int().min(0).max(1_000_000_000), default: 0 }),
  "billing.creditPolicy": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Credit policy (internal)", control: "textarea", schema: text(1000), default: "" }),
  "billing.invoiceEmailTemplate": def({ scope: "PROPERTY", perm: "settings.manage", group: "billing", label: "Invoice email template (saved; sending needs an email provider)", control: "textarea", schema: text(2000), default: "" }),

  // Security (tenant-wide)
  "security.sessionMinutes": def({ scope: "TENANT", perm: "users.manage", group: "security", label: "Sign people out after (minutes)", control: "number", min: 15, max: 720, help: "Counted from sign-in. Between 15 and 720.", schema: z.number().int().min(15).max(720), default: 720 }),

  // Notifications (tenant-wide)
  "notifications.provider": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Email provider", control: "select", help: "No provider is connected yet; emails are only queued.", options: opts(["NONE", "SMTP", "SENDGRID", "SES", "RESEND"]), schema: z.enum(["NONE", "SMTP", "SENDGRID", "SES", "RESEND"]), default: "NONE" as const }),
  "notifications.fromEmail": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Send from address", control: "text", schema: emailOrEmpty, default: "" }),
  "notifications.apiKey": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Provider API key", control: "secret", help: "Stored encrypted and never shown again. Leave blank to keep the current key.", secret: true, schema: z.string().trim().min(8).max(500), default: "" }),
  "notifications.tplBookingConfirmation": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Booking confirmation template", control: "textarea", schema: text(2000), default: "" }),
  "notifications.tplPaymentReceipt": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Payment receipt template", control: "textarea", schema: text(2000), default: "" }),
  "notifications.tplCheckoutReminder": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Check-out reminder template", control: "textarea", schema: text(2000), default: "" }),
  "notifications.alertLowRating": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Alert on low guest ratings", control: "checkbox", schema: z.boolean(), default: true }),
  "notifications.alertMaintenance": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Alert on maintenance blocks", control: "checkbox", schema: z.boolean(), default: true }),
  "notifications.alertChannelSync": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Alert on channel sync problems", control: "checkbox", schema: z.boolean(), default: true }),
  "notifications.alertBackupFailure": def({ scope: "TENANT", perm: "settings.manage", group: "notifications", label: "Alert on backup failure", control: "checkbox", schema: z.boolean(), default: true }),

  // Reports
  "reports.defaultRangeDays": def({ scope: "PROPERTY", perm: "settings.manage", group: "reports", label: "Default report range (days)", control: "number", min: 1, max: 366, schema: z.number().int().min(1).max(366), default: 30 }),
  "reports.revenueDefinition": def({ scope: "PROPERTY", perm: "settings.manage", group: "reports", label: "How your hotel defines revenue (note for your team)", control: "textarea", schema: text(1000), default: "" }),

  // Backup (tenant-wide, owner only)
  "backup.retentionDays": def({ scope: "TENANT", perm: "backup.configure", group: "backup", label: "Backup retention you require (days)", control: "number", min: 7, max: 3650, help: "A record of your policy. Backups themselves are run by your database host.", schema: z.number().int().min(7).max(3650), default: 30 }),
  "backup.notes": def({ scope: "TENANT", perm: "backup.configure", group: "backup", label: "Recovery notes", control: "textarea", schema: text(2000), default: "" }),
  "backup.restoreTests": def({ scope: "TENANT", perm: "backup.configure", group: "backup", label: "Restore-test history", control: "text", schema: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), result: z.enum(["PASSED", "FAILED"]), notes: z.string().trim().max(300) })).max(50), default: [] as { date: string; result: "PASSED" | "FAILED"; notes: string }[] }),
} as const;

export type SettingKey = keyof typeof DEFS;
export type SettingValues = { [K in SettingKey]: z.output<(typeof DEFS)[K]["schema"]> };
export const SETTING_KEYS = Object.keys(DEFS) as SettingKey[];
export const keysIn = (group: Group) => SETTING_KEYS.filter((k) => DEFS[k].group === group);

/** Tailwind classes per palette colour. Written out in full so the stylesheet generator can see them. */
export const PALETTE: Record<PaletteKey, { chip: string; cell: string }> = {
  green: { chip: "bg-green-100 text-green-900 border-green-300", cell: "border-green-400 bg-green-50" },
  blue: { chip: "bg-blue-100 text-blue-900 border-blue-300", cell: "border-blue-400 bg-blue-50" },
  orange: { chip: "bg-orange-100 text-orange-900 border-orange-300", cell: "border-orange-400 bg-orange-50" },
  slate: { chip: "bg-slate-200 text-slate-900 border-slate-400", cell: "border-slate-400 bg-slate-100" },
  red: { chip: "bg-red-100 text-red-900 border-red-300", cell: "border-red-400 bg-red-50" },
  purple: { chip: "bg-purple-100 text-purple-900 border-purple-300", cell: "border-purple-400 bg-purple-50" },
  yellow: { chip: "bg-yellow-100 text-yellow-900 border-yellow-400", cell: "border-yellow-400 bg-yellow-50" },
  teal: { chip: "bg-teal-100 text-teal-900 border-teal-300", cell: "border-teal-400 bg-teal-50" },
  pink: { chip: "bg-pink-100 text-pink-900 border-pink-300", cell: "border-pink-400 bg-pink-50" },
};

export type StatusMeta = Record<DisplayStatus, { label: string; icon: string; chip: string; cell: string; hint: string }>;

/** The built-in status look with the property's label and colour choices applied. Status codes never change. */
export function resolveStatusMeta(overrides: Partial<Record<DisplayStatus, { label?: string; color?: PaletteKey }>> = {}): StatusMeta {
  const out = { ...STATUS_META } as StatusMeta;
  for (const s of DISPLAY_STATUSES) {
    const o = overrides[s];
    if (!o) continue;
    out[s] = { ...STATUS_META[s], ...(o.label ? { label: o.label } : {}), ...(o.color ? PALETTE[o.color] : {}) };
  }
  return out;
}
