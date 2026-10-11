import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { encryptSecret } from "@/server/crypto";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { DEFS, SETTING_KEYS, type SettingKey, type SettingValues } from "@/server/domain/settings";
import { audit } from "./audit";

type Tx = Prisma.TransactionClient;
const MASK = "••••••••";

/**
 * Effective settings for a property: stored values where valid, otherwise the built-in default. Secrets are never
 * returned (their slot holds the default). No permission check: services use this to apply the hotel's own rules.
 */
export async function loadSettings(tx: Tx, tenantId: string, propertyId: string | null): Promise<SettingValues> {
  const rows = await tx.setting.findMany({
    where: { tenantId, OR: [{ scope: "TENANT", scopeId: tenantId }, ...(propertyId ? [{ scope: "PROPERTY", scopeId: propertyId }] : [])] },
  });
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const d = DEFS[key];
    const row = rows.find((r) => r.key === key && r.scope === d.scope);
    const parsed = row && !("secret" in d && d.secret) ? d.schema.safeParse(row.value) : null;
    out[key] = parsed?.success ? parsed.data : d.default;
  }
  return out as SettingValues;
}

/** Settings for the current property, for use by services that enforce the hotel's rules. */
export async function settingsFor(db: PrismaClient, ctx: Pick<Ctx, "tenantId" | "propertyId">): Promise<SettingValues> {
  return withTenant(db, ctx.tenantId, (tx) => loadSettings(tx, ctx.tenantId, ctx.propertyId));
}

/** What the settings screens show: values plus which secrets are set (never the secrets themselves). */
export async function getSettingsForAdmin(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "settings.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const values = await loadSettings(tx, ctx.tenantId, propertyId);
    const secretKeys = SETTING_KEYS.filter((k) => "secret" in DEFS[k] && DEFS[k].secret);
    const set = await tx.setting.findMany({ where: { tenantId: ctx.tenantId, key: { in: secretKeys } }, select: { key: true } });
    return { values, secretsSet: new Set(set.map((s) => s.key)) };
  });
}

function label(key: SettingKey) {
  return DEFS[key].label.replace(/\s*\(.*$/, "");
}

/**
 * Saves some settings. Each key is checked against the catalogue (type, range, permission), only changed values are
 * written, and every change is audited with before and after (secrets masked). Nothing outside the catalogue can be stored.
 */
export async function setSettings(db: PrismaClient, ctx: Ctx, input: Record<string, unknown>) {
  const propertyId = requireProperty(ctx);
  const keys = Object.keys(input);
  if (keys.length === 0) throw new AppError("VALIDATION", "Nothing to save.");
  for (const k of keys) {
    if (!(k in DEFS)) throw new AppError("VALIDATION", `Unknown setting: ${k.slice(0, 60)}.`);
    authorize(ctx, DEFS[k as SettingKey].perm);
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    const current = await loadSettings(tx, ctx.tenantId, propertyId);
    const next: Record<string, unknown> = {};
    for (const k of keys as SettingKey[]) {
      const d = DEFS[k];
      const raw = input[k];
      if ("secret" in d && d.secret && (raw === "" || raw === undefined)) continue; // blank keeps the stored key
      const parsed = d.schema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION", `${label(k)}: ${parsed.error.issues[0]?.message ?? "invalid value."}`);
      next[k] = parsed.data;
    }
    const merged = { ...current, ...next } as SettingValues;
    if (merged["reservation.minNights"] > merged["reservation.maxNights"]) {
      throw new AppError("VALIDATION", "The minimum stay cannot be longer than the maximum stay.");
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, value] of Object.entries(next) as [SettingKey, unknown][]) {
      const d = DEFS[k];
      const isSecret = "secret" in d && d.secret;
      const old = (current as Record<string, unknown>)[k];
      if (!isSecret && JSON.stringify(old) === JSON.stringify(value)) continue;
      const scopeId = d.scope === "TENANT" ? ctx.tenantId : propertyId;
      const stored = (isSecret ? encryptSecret(String(value)) : value) as Prisma.InputJsonValue;
      await tx.setting.upsert({
        where: { tenantId_scope_scopeId_key: { tenantId: ctx.tenantId, scope: d.scope, scopeId, key: k } },
        create: { tenantId: ctx.tenantId, scope: d.scope, scopeId, key: k, value: stored, updatedBy: ctx.userId },
        update: { value: stored, updatedBy: ctx.userId },
      });
      before[k] = isSecret ? (old ? MASK : "") : old;
      after[k] = isSecret ? MASK : value;
    }
    const changed = Object.keys(after);
    if (changed.length) {
      await audit(tx, ctx, { action: "settings.update", entityType: "Setting", before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue });
    }
    return { changed };
  });
}

/** Adds a restore-test record to the backup history (owner-level permission). */
export async function addRestoreTest(db: PrismaClient, ctx: Ctx, entry: { date: string; result: "PASSED" | "FAILED"; notes: string }) {
  authorize(ctx, "backup.configure");
  const propertyId = requireProperty(ctx);
  const current = await withTenant(db, ctx.tenantId, (tx) => loadSettings(tx, ctx.tenantId, propertyId));
  const list = [...current["backup.restoreTests"], entry].slice(-50);
  return setSettings(db, ctx, { "backup.restoreTests": list });
}

export type { SettingValues };
