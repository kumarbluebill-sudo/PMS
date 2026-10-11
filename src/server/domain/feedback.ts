export const LOW_RATING_MAX = 2;
export const POSITIVE_RATING_MIN = 4;

export const FEEDBACK_CATEGORIES = [
  { key: "cleanliness", label: "Room cleanliness" },
  { key: "service", label: "Staff service" },
  { key: "food", label: "Food quality" },
  { key: "facilities", label: "Facilities" },
] as const;
export type FeedbackCategoryKey = (typeof FEEDBACK_CATEGORIES)[number]["key"];

export const COMPLAINT_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
export const COMPLAINT_LABELS: Record<string, string> = { NONE: "No follow-up needed", OPEN: "Open", IN_PROGRESS: "In progress", RESOLVED: "Resolved" };

/** A low overall rating opens a complaint for follow-up. */
export const initialComplaintStatus = (overall: number) => (overall <= LOW_RATING_MAX ? "OPEN" : "NONE");

/** Average to two decimals, or null when there is nothing to average. */
export const roundAvg = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

/** Summary from a rating distribution (rating -> count), so it is exact whatever the volume. */
export function summarizeDistribution(dist: Record<number, number>) {
  let count = 0, sum = 0, positive = 0, low = 0;
  for (const [rating, n] of Object.entries(dist)) {
    const r = Number(rating);
    count += n;
    sum += r * n;
    if (r >= POSITIVE_RATING_MIN) positive += n;
    if (r <= LOW_RATING_MAX) low += n;
  }
  return { count, average: count ? Math.round((sum / count) * 100) / 100 : null, positive, low };
}

/** Feedback links carry the tenant id so a link can be resolved without a login; the rest is random. */
const TOKEN_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{40,})$/i;
export function parseFeedbackToken(token: string): { tenantId: string } | null {
  const m = TOKEN_RE.exec(token);
  return m ? { tenantId: m[1].toLowerCase() } : null;
}
