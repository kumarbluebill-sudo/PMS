"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { reportIssue } from "@/server/services/roomBlocks";
import { createTask, generateStayoverTasks, setDnd, taskAction } from "@/server/services/housekeepingTasks";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Back to the housekeeping list the person was on (same filters), nowhere else. */
const backOf = (fd: FormData) => (/^\/app\/housekeeping(\?[\w=&%.\-+]*)?$/.test(str(fd.get("back"))) ? str(fd.get("back")) : "/app/housekeeping");

async function done(back: string, fn: () => Promise<string | void>, ok: string) {
  let error: string | null = null;
  let msg = ok;
  try {
    const r = await fn();
    if (typeof r === "string" && r) msg = r;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(msg)}`}`);
}

const OK: Record<string, string> = {
  START: "Cleaning started.", COMPLETE: "Marked clean.", REQUEST_INSPECTION: "Inspection requested.", INSPECT_PASS: "Inspection passed. The room is ready.",
  INSPECT_FAIL: "Inspection failed. The room is back on the cleaning list.", REOPEN: "Task reopened. The room is dirty again.", CANCEL: "Task cancelled.",
  ASSIGN: "Assignment saved.", NOTE: "Note added.", PRIORITY: "Priority changed.",
};

export async function taskActionAction(fd: FormData) {
  const ctx = await getCtx();
  const action = str(fd.get("action"));
  await done(backOf(fd), async () => {
    await taskAction(getDb(), ctx, {
      taskId: str(fd.get("taskId")), action, expectedVersion: Number(str(fd.get("version"))),
      ...(fd.has("assignedTo") ? { assignedTo: str(fd.get("assignedTo")) || null } : {}),
      note: str(fd.get("note")) || undefined, priority: str(fd.get("priority")) || undefined,
    });
  }, OK[action] ?? "Saved.");
}

export async function dndAction(fd: FormData) {
  const ctx = await getCtx();
  const on = str(fd.get("dnd")) === "true";
  await done(backOf(fd), async () => { await setDnd(getDb(), ctx, str(fd.get("roomId")), on, str(fd.get("note")) || undefined); }, on ? "Marked Do Not Disturb." : "Do Not Disturb cleared.");
}

export async function createTaskAction(fd: FormData) {
  const ctx = await getCtx();
  await done(backOf(fd), async () => { await createTask(getDb(), ctx, { roomId: str(fd.get("roomId")), kind: str(fd.get("kind")) || "PRIORITY", priority: str(fd.get("priority")) || "NORMAL", note: str(fd.get("note")) || undefined }); }, "Cleaning task created.");
}

export async function stayoverAction(fd: FormData) {
  const ctx = await getCtx();
  await done(backOf(fd), async () => {
    const r = await generateStayoverTasks(getDb(), ctx);
    return `Stayover tasks: ${r.created} created${r.existing ? `, ${r.existing} already had one` : ""}${r.skippedDnd ? `, ${r.skippedDnd} skipped (Do Not Disturb)` : ""}.`;
  }, "Done.");
}

export async function reportIssueAction(fd: FormData) {
  const ctx = await getCtx();
  await done(backOf(fd), async () => {
    await reportIssue(getDb(), ctx, { roomId: str(fd.get("roomId")), category: str(fd.get("category")) || "OTHER", title: str(fd.get("title")), description: str(fd.get("description")) || undefined, mode: "REPORT", priority: str(fd.get("priority")) || "NORMAL" });
  }, "Issue reported to maintenance.");
}
