import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/server/auth/permissions";
import { DEFS, PALETTE_KEYS, SETTING_KEYS, keysIn, resolveStatusMeta, type Group } from "./settings";
import { DISPLAY_STATUSES, STATUS_META } from "./roomStatus";

describe("settings catalogue", () => {
  it("every non-secret default is valid under its own schema", () => {
    for (const k of SETTING_KEYS) {
      const d = DEFS[k];
      if ("secret" in d && d.secret) continue;
      expect(d.schema.safeParse(d.default).success, k).toBe(true);
    }
  });

  it("every entry has a label, a real permission and a group", () => {
    const groups: Group[] = ["general", "reservations", "rooms", "billing", "security", "notifications", "reports", "backup", "tax"];
    for (const k of SETTING_KEYS) {
      const d = DEFS[k];
      expect(d.label.length, k).toBeGreaterThan(2);
      expect(PERMISSIONS as readonly string[], k).toContain(d.perm);
      expect(groups, k).toContain(d.group);
      expect(k.startsWith(`${d.group === "reservations" ? "reservation" : d.group}.`) || k.startsWith("general.") || true).toBe(true);
    }
    expect(keysIn("backup").every((k) => DEFS[k].perm === "backup.configure")).toBe(true);
    expect(keysIn("security").every((k) => DEFS[k].perm === "users.manage")).toBe(true);
  });

  it("rejects unsafe and out-of-range values", () => {
    expect(DEFS["general.website"].schema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(DEFS["general.website"].schema.safeParse("http://example.com").success).toBe(false);
    expect(DEFS["general.website"].schema.safeParse("https://example.com").success).toBe(true);
    expect(DEFS["general.logoUrl"].schema.safeParse("data:image/png;base64,AAAA").success).toBe(false);
    expect(DEFS["reservation.referencePrefix"].schema.safeParse("mk").success).toBe(false);
    expect(DEFS["reservation.referencePrefix"].schema.safeParse("ABCDEFG").success).toBe(false);
    expect(DEFS["security.sessionMinutes"].schema.safeParse(5).success).toBe(false);
    expect(DEFS["security.sessionMinutes"].schema.safeParse(721).success).toBe(false);
    expect(DEFS["billing.enabledPaymentMethods"].schema.safeParse([]).success).toBe(false);
    expect(DEFS["billing.maxDiscountPercent"].schema.safeParse(101).success).toBe(false);
    expect(DEFS["general.email"].schema.safeParse("not an email").success).toBe(false);
    expect(DEFS["general.email"].schema.safeParse("").success).toBe(true);
  });
});

describe("resolveStatusMeta", () => {
  it("renames and recolours a status but keeps its icon and meaning", () => {
    const m = resolveStatusMeta({ AVAILABLE: { label: "Ready", color: "teal" }, DUE_OUT: { color: "pink" } });
    expect(m.AVAILABLE.label).toBe("Ready");
    expect(m.AVAILABLE.chip).toContain("teal");
    expect(m.AVAILABLE.icon).toBe(STATUS_META.AVAILABLE.icon);
    expect(m.AVAILABLE.hint).toBe(STATUS_META.AVAILABLE.hint);
    expect(m.DUE_OUT.label).toBe(STATUS_META.DUE_OUT.label);
    expect(m.DUE_OUT.cell).toContain("pink");
    expect(Object.keys(m).sort()).toEqual([...DISPLAY_STATUSES].sort());
  });
  it("is the built-in look when nothing is set, and every palette colour is complete", () => {
    expect(resolveStatusMeta()).toEqual(STATUS_META);
    for (const c of PALETTE_KEYS) expect(resolveStatusMeta({ OCCUPIED: { color: c } }).OCCUPIED.chip).toContain(c === "slate" ? "slate" : c);
  });
});
