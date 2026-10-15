/**
 * Starting tax rules a hotel can apply with one click. They are only defaults: each becomes a DRAFT rule that a
 * second authorised person approves, and the hotel's accountant must check every one against the official
 * notification before approving. Nothing here is applied automatically and no other category (restaurant, banquet,
 * laundry, transport) is ever defaulted.
 *
 * Tariff bands are per room per day in paise. `tariffMaxMinor` is exclusive, so "₹7,500 or less" is 750001.
 */
export type PresetRule = {
  category: "ROOM";
  description: string;
  sacCode: string;
  treatment: "TAXABLE" | "EXEMPT" | "NIL_RATED";
  ratePercent: number;
  tariffMinMinor?: number;
  tariffMaxMinor?: number;
  effectiveFrom: string;
  effectiveTo?: string;
  legalRef: string;
};

export type Preset = { id: string; title: string; summary: string; rules: PresetRule[] };

export const CHANGE_DATE = "2025-09-22";
const REVIEW = "ACCOUNTANT REVIEW REQUIRED: check against the current official notification and its conditions before approving.";
const SAC = "996311";
const LIMIT = 750_001; // ₹7,500 or less is below this (exclusive upper bound)
const LOW = 100_001; // ₹1,000 or less is below this

export const ACCOMMODATION_PRESETS: Preset[] = [
  {
    id: "accommodation-2025",
    title: "Hotel accommodation from 22 September 2025",
    summary: "Up to ₹7,500 per room per day: 5% (without input tax credit). Above ₹7,500: 18%.",
    rules: [
      { category: "ROOM", description: "Accommodation up to Rs. 7,500 per room per day, 5% without input tax credit", sacCode: SAC, treatment: "TAXABLE", ratePercent: 5, tariffMaxMinor: LIMIT, effectiveFrom: CHANGE_DATE, legalRef: `GST rate change effective ${CHANGE_DATE}. ${REVIEW}` },
      { category: "ROOM", description: "Accommodation above Rs. 7,500 per room per day, 18%", sacCode: SAC, treatment: "TAXABLE", ratePercent: 18, tariffMinMinor: LIMIT, effectiveFrom: CHANGE_DATE, legalRef: `GST rate change effective ${CHANGE_DATE}. ${REVIEW}` },
    ],
  },
  {
    id: "accommodation-before-2025",
    title: "Hotel accommodation before 22 September 2025 (for older bookings)",
    summary: "Up to ₹1,000: exempt. ₹1,001 to ₹7,500: 12%. Above ₹7,500: 18%. Ends on 22 September 2025.",
    rules: [
      { category: "ROOM", description: "Accommodation up to Rs. 1,000 per room per day, exempt", sacCode: SAC, treatment: "EXEMPT", ratePercent: 0, tariffMaxMinor: LOW, effectiveFrom: "2019-10-01", effectiveTo: CHANGE_DATE, legalRef: `Slabs in force from 1 Oct 2019 until ${CHANGE_DATE}. ${REVIEW}` },
      { category: "ROOM", description: "Accommodation Rs. 1,001 to Rs. 7,500 per room per day, 12%", sacCode: SAC, treatment: "TAXABLE", ratePercent: 12, tariffMinMinor: LOW, tariffMaxMinor: LIMIT, effectiveFrom: "2019-10-01", effectiveTo: CHANGE_DATE, legalRef: `Slabs in force from 1 Oct 2019 until ${CHANGE_DATE}. ${REVIEW}` },
      { category: "ROOM", description: "Accommodation above Rs. 7,500 per room per day, 18%", sacCode: SAC, treatment: "TAXABLE", ratePercent: 18, tariffMinMinor: LIMIT, effectiveFrom: "2019-10-01", effectiveTo: CHANGE_DATE, legalRef: `Slabs in force from 1 Oct 2019 until ${CHANGE_DATE}. ${REVIEW}` },
    ],
  },
];

export const presetById = (id: string) => ACCOMMODATION_PRESETS.find((p) => p.id === id) ?? null;

/** The service categories the hotel must configure itself. None has a default. */
export const OWN_RULE_CATEGORIES: { category: string; label: string; hint: string }[] = [
  { category: "FNB", label: "Restaurant and food and beverage", hint: "Depends on how the outlet is classified; set the rate your accountant confirms." },
  { category: "BANQUET", label: "Banquet and events", hint: "Hall rental and catering can be taxed differently." },
  { category: "SPA", label: "Spa and wellness", hint: "" },
  { category: "LAUNDRY", label: "Laundry", hint: "" },
  { category: "TRANSPORT", label: "Transport and transfers", hint: "" },
  { category: "EXTRA_BED", label: "Extra bed", hint: "Often follows the room rate; confirm with your accountant." },
  { category: "OTHER", label: "Other services", hint: "" },
];
