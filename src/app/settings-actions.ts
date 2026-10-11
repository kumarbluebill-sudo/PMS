"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { rupeesToMinor } from "@/server/money";
import { DEFS, PALETTE_KEYS, type SettingKey } from "@/server/domain/settings";
import { DISPLAY_STATUSES } from "@/server/domain/roomStatus";
import { addRestoreTest, setSettings } from "@/server/services/settings";
import { updateProperty } from "@/server/services/stays";
import { createProperty } from "@/server/services/rooms";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Same-site settings paths only. */
const safeBack = (v: string) => (/^\/app\/settings\/[\w-]+$/.test(v) ? v : "/app/settings/general");

async function done(back: string, fn: () => Promise<unknown>, ok: string) {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(`${back}?${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}

/** Converts one submitted field to the type its catalogue entry expects. The form never decides the type. */
function fromForm(key: SettingKey, fd: FormData): unknown {
  const d = DEFS[key];
  if (d.control === "checkbox") return fd.get(key) === "on";
  if (d.control === "multi") return fd.getAll(key).map(String);
  if (d.control === "number") {
    const raw = str(fd.get(key)).trim();
    if (key === "billing.refundApprovalLimitMinor") return raw === "" ? 0 : rupeesToMinor(raw);
    return raw === "" ? Number.NaN : Number(raw);
  }
  if (key === "rooms.housekeepingCategories") return str(fd.get(key)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return str(fd.get(key));
}

export async function saveSettingsAction(fd: FormData) {
  const ctx = await getCtx();
  const back = safeBack(str(fd.get("back")));
  const keys = fd.getAll("keys").map(String).filter((k): k is SettingKey => k in DEFS);
  await done(back, () => setSettings(getDb(), ctx, Object.fromEntries(keys.map((k) => [k, fromForm(k, fd)]))), "Settings saved.");
}

export async function saveStatusLabelsAction(fd: FormData) {
  const ctx = await getCtx();
  const value: Record<string, { label?: string; color?: string }> = {};
  for (const s of DISPLAY_STATUSES) {
    const label = str(fd.get(`label_${s}`)).trim();
    const color = str(fd.get(`color_${s}`));
    if (label || (color && (PALETTE_KEYS as readonly string[]).includes(color))) {
      value[s] = { ...(label && { label }), ...(color && { color }) };
    }
  }
  await done("/app/settings/rooms", () => setSettings(getDb(), ctx, { "rooms.statusLabels": value }), "Status labels saved.");
}

export async function savePropertyAction(fd: FormData) {
  const ctx = await getCtx();
  await done(
    "/app/settings/general",
    () =>
      updateProperty(getDb(), ctx, {
        name: str(fd.get("name")), address: str(fd.get("address")) || undefined, timezone: str(fd.get("timezone")),
        checkInTime: str(fd.get("checkInTime")), checkOutTime: str(fd.get("checkOutTime")),
      }),
    "Property details saved.",
  );
}

export async function addRestoreTestAction(fd: FormData) {
  const ctx = await getCtx();
  await done(
    "/app/settings/backup",
    () => addRestoreTest(getDb(), ctx, { date: str(fd.get("date")), result: str(fd.get("result")) as "PASSED", notes: str(fd.get("notes")).trim() }),
    "Restore test recorded.",
  );
}

export async function createPropertyAction(fd: FormData) {
  const ctx = await getCtx();
  await done("/app/settings/property", () => createProperty(getDb(), ctx, { name: str(fd.get("name")) }), "Property added. Use the property switcher to open it.");
}
