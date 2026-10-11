"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { toSafeError } from "@/server/errors";
import { rateLimit } from "@/server/rateLimit";
import { PERMISSIONS, ROLES, type Permission, type RoleKey } from "@/server/auth/permissions";
import {
  acceptInvite, beginMfaEnrolment, confirmMfaEnrolment, inviteMember, requestPasswordReset,
  resetMemberMfa, resetPassword, sendVerification, verifyEmail,
} from "@/server/services/accounts";
import { updateMember } from "@/server/services/users";
import { changeDeparture, moveRoom, updateProperty } from "@/server/services/stays";
import { approveBlock, reportIssue, resolveIssue, updateIssue, type ReportIssueInput } from "@/server/services/roomBlocks";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Runs a mutation, then redirects to `back` with either ?error= or ?ok=. */
async function run(back: string, fn: () => Promise<unknown>, ok?: string) {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  const sep = back.includes("?") ? "&" : "?";
  redirect(error ? `${back}${sep}error=${encodeURIComponent(error)}` : ok ? `${back}${sep}ok=${encodeURIComponent(ok)}` : back);
}

export async function forgotPasswordAction(fd: FormData) {
  const email = str(fd.get("email")).trim().toLowerCase();
  // Same response whether or not the email exists, and whether or not we were rate limited.
  if (rateLimit(`forgot:${email}`, 5, 60 * 60_000)) await requestPasswordReset(getDb(), email);
  redirect("/forgot-password?ok=If%20that%20email%20is%20registered%2C%20a%20reset%20link%20has%20been%20sent.");
}

export async function resetPasswordAction(fd: FormData) {
  const token = str(fd.get("token"));
  let error: string | null = null;
  try {
    await resetPassword(getDb(), token, str(fd.get("password")));
  } catch (e) {
    error = toSafeError(e).message;
  }
  if (error) redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(error)}`);
  redirect("/login?error=Password%20updated.%20Please%20sign%20in.");
}

export async function verifyEmailAction(fd: FormData) {
  await run("/login", () => verifyEmail(getDb(), str(fd.get("token"))), "Email verified. You can sign in.");
}

export async function resendVerificationAction() {
  const ctx = await getCtx();
  if (rateLimit(`verify:${ctx.userId}`, 3, 60 * 60_000)) await sendVerification(getDb(), ctx.userId);
  redirect("/app/dashboard");
}

export async function acceptInviteAction(fd: FormData) {
  const token = str(fd.get("token"));
  let error: string | null = null;
  try {
    await acceptInvite(getDb(), token, { name: str(fd.get("name")), password: str(fd.get("password")) });
  } catch (e) {
    error = toSafeError(e).message;
  }
  if (error) redirect(`/invite?token=${encodeURIComponent(token)}&error=${encodeURIComponent(error)}`);
  redirect("/login?error=Account%20created.%20Please%20sign%20in.");
}

export async function inviteAction(fd: FormData) {
  const ctx = await getCtx();
  await run(
    "/app/users",
    () =>
      inviteMember(getDb(), ctx, {
        email: str(fd.get("email")),
        role: str(fd.get("role")) as RoleKey,
        propertyIds: fd.getAll("propertyIds").map(String),
      }),
    "Invitation sent.",
  );
}

export async function updateMemberAction(fd: FormData) {
  const ctx = await getCtx();
  const role = str(fd.get("role"));
  await run(
    "/app/users",
    () =>
      updateMember(getDb(), ctx, str(fd.get("membershipId")), {
        role: (ROLES as readonly string[]).includes(role) ? (role as RoleKey) : undefined,
        active: fd.get("active") === "on",
        extra: fd.getAll("extra").map(String).filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p)),
        propertyIds: fd.getAll("propertyIds").map(String),
      }),
    "Member updated.",
  );
}

export async function resetMfaAction(fd: FormData) {
  const ctx = await getCtx();
  await run("/app/users", () => resetMemberMfa(getDb(), ctx, str(fd.get("userId"))), "MFA reset. The member must re-enrol.");
}

export async function mfaBeginAction() {
  const ctx = await getCtx({ allowMfaSetup: true });
  await run("/security", () => beginMfaEnrolment(getDb(), ctx));
}

export async function mfaConfirmAction(fd: FormData) {
  const ctx = await getCtx({ allowMfaSetup: true });
  await run("/security", () => confirmMfaEnrolment(getDb(), ctx, str(fd.get("code"))), "MFA enabled.");
}

/** Only same-site /app paths are accepted as a return target. */
const backTo = (fd: FormData, fallback: string) => {
  const b = str(fd.get("back"));
  return /^\/app\/[\w\-/]*(\?[\w=&\-%.]*)?$/.test(b) ? b : fallback;
};

export async function extendStayAction(fd: FormData) {
  const ctx = await getCtx();
  await run(backTo(fd, "/app/front-desk"), () => changeDeparture(getDb(), ctx, str(fd.get("id")), str(fd.get("departure"))), "Departure changed.");
}

export async function moveRoomAction(fd: FormData) {
  const ctx = await getCtx();
  await run(backTo(fd, "/app/front-desk"), () => moveRoom(getDb(), ctx, str(fd.get("id")), str(fd.get("roomId")), str(fd.get("reason"))), "Room changed.");
}

const checked = (fd: FormData, k: string) => fd.get(k) === "on";

export async function reportIssueAction(fd: FormData) {
  const ctx = await getCtx();
  const opt = (k: string) => str(fd.get(k)).trim() || undefined;
  const roomId = str(fd.get("roomId"));
  let id: string | null = null;
  let error: string | null = null;
  try {
    const m = await reportIssue(getDb(), ctx, {
      roomId, mode: str(fd.get("mode")) as ReportIssueInput["mode"], category: str(fd.get("category")) as ReportIssueInput["category"],
      title: str(fd.get("title")), description: opt("description"), priority: (opt("priority") ?? "NORMAL") as ReportIssueInput["priority"],
      startDate: opt("startDate"), expectedResolution: opt("expectedResolution"), assignedTo: opt("assignedTo"),
      acknowledgeBookings: checked(fd, "acknowledgeBookings"),
    });
    id = m.id;
  } catch (e) {
    error = toSafeError(e).message;
  }
  revalidatePath("/app", "layout");
  if (error) redirect(`/app/maintenance?roomId=${encodeURIComponent(roomId)}&error=${encodeURIComponent(error)}`);
  redirect(`/app/maintenance/${id}?ok=Recorded.`);
}

export async function resolveIssueAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await run(`/app/maintenance/${encodeURIComponent(id)}`, () => resolveIssue(getDb(), ctx, id, { resolutionNote: str(fd.get("resolutionNote")), confirmReady: checked(fd, "confirmReady") }), "Resolved.");
}

export async function approveBlockAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  await run(`/app/maintenance/${encodeURIComponent(id)}`, () => approveBlock(getDb(), ctx, id), "Block approved.");
}

export async function updateIssueAction(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd.get("id"));
  const assignee = str(fd.get("assignedTo"));
  const status = str(fd.get("status"));
  await run(`/app/maintenance/${encodeURIComponent(id)}`, () =>
    updateIssue(getDb(), ctx, id, { ...(status && { status }), ...(fd.has("assignedTo") && { assignedTo: assignee || null }) }), "Updated.");
}

export async function updatePropertyAction(fd: FormData) {
  const ctx = await getCtx();
  await run(
    "/onboarding",
    () =>
      updateProperty(getDb(), ctx, {
        name: str(fd.get("name")),
        address: str(fd.get("address")) || undefined,
        timezone: str(fd.get("timezone")),
        checkInTime: str(fd.get("checkInTime")),
        checkOutTime: str(fd.get("checkOutTime")),
      }),
    "Property saved.",
  );
}
