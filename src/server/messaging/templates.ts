export const TEMPLATE_KEYS = [
  "reservation_confirmation",
  "booking_change",
  "pre_arrival",
  "checkin_confirmation",
  "checkout_reminder",
  "payment_reminder",
  "invoice_share",
  "feedback_request",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  reservation_confirmation: "Reservation confirmation",
  booking_change: "Booking modification or cancellation",
  pre_arrival: "Pre-arrival information",
  checkin_confirmation: "Check-in confirmation",
  checkout_reminder: "Checkout reminder",
  payment_reminder: "Outstanding payment reminder",
  invoice_share: "Invoice or receipt sharing",
  feedback_request: "Post-checkout feedback request",
};

/** Variables a template may use. Anything else is left visible so mistakes show up in previews. */
export const TEMPLATE_VARS = ["guest", "hotel", "reference", "arrival", "departure", "balance"] as const;

export const DEFAULT_BODIES: Record<TemplateKey, string> = {
  reservation_confirmation: "Hello {{guest}}, your booking {{reference}} at {{hotel}} is confirmed for {{arrival}} to {{departure}}.",
  booking_change: "Hello {{guest}}, your booking {{reference}} at {{hotel}} has been updated. Stay: {{arrival}} to {{departure}}.",
  pre_arrival: "Hello {{guest}}, we look forward to welcoming you at {{hotel}} on {{arrival}}. Booking {{reference}}.",
  checkin_confirmation: "Welcome to {{hotel}}, {{guest}}. You are checked in under booking {{reference}}. Departure: {{departure}}.",
  checkout_reminder: "Hello {{guest}}, a reminder that checkout from {{hotel}} is on {{departure}}. Booking {{reference}}.",
  payment_reminder: "Hello {{guest}}, an amount of {{balance}} is outstanding on booking {{reference}} at {{hotel}}.",
  invoice_share: "Hello {{guest}}, thank you for staying at {{hotel}}. Your invoice for booking {{reference}} is ready at the front desk.",
  feedback_request: "Thank you for staying at {{hotel}}, {{guest}}. We would value your feedback on booking {{reference}}.",
};

export function renderTemplate(body: string, vars: Partial<Record<(typeof TEMPLATE_VARS)[number], string>>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? (vars as Record<string, string>)[k] : m));
}
