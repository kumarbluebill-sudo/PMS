/**
 * A block (out of order or maintenance) covers the dates from `startDate` to `expectedResolution`, both inclusive.
 * A missing start means "already in effect"; a missing end means "until resolved". Dates are YYYY-MM-DD.
 */
export type BlockWindow = { startDate: string | null; expectedResolution: string | null };

export const ISSUE_CATEGORIES = [
  "PLUMBING", "ELECTRICAL", "AIR_CONDITIONING", "FURNITURE_DAMAGE", "BATHROOM", "RENOVATION", "SAFETY", "CLEANING", "OTHER",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  PLUMBING: "Plumbing",
  ELECTRICAL: "Electrical",
  AIR_CONDITIONING: "Air conditioning",
  FURNITURE_DAMAGE: "Furniture damage",
  BATHROOM: "Bathroom issue",
  RENOVATION: "Renovation",
  SAFETY: "Safety concern",
  CLEANING: "Cleaning issue",
  OTHER: "Other",
};

export const ISSUE_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const ISSUE_MODES = ["REPORT", "MAINTENANCE_BLOCK", "OUT_OF_ORDER"] as const;
export type IssueMode = (typeof ISSUE_MODES)[number];

/** Is the room blocked on this calendar date? */
export function blockCoversDate(w: BlockWindow, date: string): boolean {
  return (w.startDate === null || w.startDate <= date) && (w.expectedResolution === null || w.expectedResolution >= date);
}

/** Does the block touch any night of a stay [arrival, departure)? */
export function blockOverlapsStay(w: BlockWindow, arrival: string, departure: string): boolean {
  return (w.startDate === null || w.startDate < departure) && (w.expectedResolution === null || w.expectedResolution >= arrival);
}
