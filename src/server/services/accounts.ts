import { generate, generateSecret, generateURI, verify } from "otplib";
import { deliverEmail } from "./emailOutbox";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, type Ctx } from "@/server/auth/context";
import { MFA_REQUIRED_ROLES, ROLES, type RoleKey } from "@/server/auth/permissions";
import { decryptSecret, encryptSecret, hashToken, newToken } from "@/server/crypto";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";
import { assertWithinPlan } from "./subscription";

const HOUR = 3_600_000;
export const passwordSchema = z.string().min(10, "Use at least 10 characters").max(200);

/** Placeholder transport: records the message in email_outbox. Swap for a real provider (Resend/SES) in deployment. */
/** Sign-in outcomes, written to the audit log of every business the person belongs to (login monitoring). */
export async function recordAuthEvent(db: PrismaClient, userId: string, action: "auth.login" | "auth.login_failed", detail?: string) {
  const ms = await db.membership.findMany({ where: { userId, active: true }, select: { tenantId: true } });
  if (ms.length === 0) return;
  await db.auditLog.createMany({
    data: ms.map((m) => ({ tenantId: m.tenantId, actorId: userId, action, entityType: "User", entityId: userId, reason: detail })),
  });
}

/**
 * Account emails (verification, password reset). Recorded, then sent if an email provider is configured. A sending
 * problem never blocks sign-up or reset: the outbox row keeps the status and the reason.
 */
export async function sendEmail(db: PrismaClient, toEmail: string, subject: string, body: string) {
  try {
    await deliverEmail(db, { kind: "ACCOUNT", to: toEmail, subject, text: body });
  } catch {
    await db.emailOutbox.create({ data: { toEmail, subject, body, status: "FAILED", error: "Could not be recorded for sending." } }).catch(() => undefined);
  }
}

const baseUrl = () => process.env.AUTH_URL ?? "http://localhost:3000";

// ---------- password reset ----------

/** Always resolves the same way so callers cannot learn whether an email is registered. */
export async function requestPasswordReset(db: PrismaClient, emailRaw: string) {
  const email = z.string().email().safeParse(emailRaw.trim().toLowerCase());
  if (!email.success) return;
  const user = await db.user.findUnique({ where: { email: email.data } });
  if (!user || !user.active) return;
  const { token, hash } = newToken();
  await db.authToken.create({
    data: { kind: "RESET", tokenHash: hash, userId: user.id, email: user.email, expiresAt: new Date(Date.now() + HOUR) },
  });
  await sendEmail(db, user.email, "Reset your password", `Reset link (valid 1 hour): ${baseUrl()}/reset-password?token=${token}`);
}

async function consumeToken(db: PrismaClient, kind: string, token: string) {
  const row = await db.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.kind !== kind || row.usedAt || row.expiresAt < new Date()) {
    throw new AppError("VALIDATION", "This link is invalid or has expired.");
  }
  // Atomic single-use: only one concurrent caller can flip usedAt from null.
  const claimed = await db.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw new AppError("VALIDATION", "This link is invalid or has expired.");
  return row;
}

export async function resetPassword(db: PrismaClient, token: string, newPassword: string) {
  const pw = passwordSchema.parse(newPassword);
  const row = await consumeToken(db, "RESET", token);
  if (!row.userId) throw new AppError("VALIDATION", "This link is invalid or has expired.");
  await db.user.update({
    where: { id: row.userId },
    data: { passwordHash: await bcrypt.hash(pw, 12), sessionEpoch: { increment: 1 } }, // revokes existing sessions
  });
  await db.auditLog.create({ data: { actorId: row.userId, action: "user.password_reset", entityType: "User", entityId: row.userId } });
}

// ---------- email verification ----------

export async function sendVerification(db: PrismaClient, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.emailVerifiedAt) return;
  const { token, hash } = newToken();
  await db.authToken.create({
    data: { kind: "VERIFY", tokenHash: hash, userId, email: user.email, expiresAt: new Date(Date.now() + 48 * HOUR) },
  });
  await sendEmail(db, user.email, "Verify your email", `Verify: ${baseUrl()}/verify-email?token=${token}`);
}

export async function verifyEmail(db: PrismaClient, token: string) {
  const row = await consumeToken(db, "VERIFY", token);
  if (row.userId) await db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
}

// ---------- invitations ----------

const ASSIGNABLE: RoleKey[] = ROLES.filter((r) => !r.startsWith("PLATFORM") && r !== "SAAS_SUPPORT_ADMIN");
const OWNER_ONLY: RoleKey[] = ["HOTEL_OWNER", "GROUP_ADMIN"];

/** Prevents privilege escalation: only owners may hand out owner-level roles. */
export function assertCanAssign(ctx: Ctx, role: RoleKey) {
  if (!ASSIGNABLE.includes(role)) throw new AppError("FORBIDDEN", "That role cannot be assigned.");
  if (OWNER_ONLY.includes(role) && ctx.role !== "HOTEL_OWNER") {
    throw new AppError("FORBIDDEN", "Only a hotel owner can assign this role.");
  }
}

export async function inviteMember(
  db: PrismaClient,
  ctx: Ctx,
  input: { email: string; role: RoleKey; propertyIds: string[] },
) {
  authorize(ctx, "users.manage");
  const d = z
    .object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES), propertyIds: z.array(z.string().uuid()) })
    .parse(input);
  assertCanAssign(ctx, d.role);
  if (d.propertyIds.some((id) => !ctx.accessiblePropertyIds.includes(id))) {
    throw new AppError("FORBIDDEN", "You cannot assign access to that property.");
  }
  if (await db.user.findUnique({ where: { email: d.email } })) {
    throw new AppError("CONFLICT", "A user with this email already exists.");
  }
  await withTenant(db, ctx.tenantId, async (tx) => {
    const pending = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM auth_tokens WHERE kind = 'INVITE' AND "tenantId" = ${ctx.tenantId}::uuid AND "usedAt" IS NULL AND "expiresAt" > now()`;
    await assertWithinPlan(tx, ctx.tenantId, "users", 1, Number(pending[0]?.n ?? 0));
  });
  const { token, hash } = newToken();
  await db.authToken.create({
    data: {
      kind: "INVITE", tokenHash: hash, email: d.email, tenantId: ctx.tenantId, role: d.role,
      propertyIds: d.propertyIds, expiresAt: new Date(Date.now() + 72 * HOUR),
    },
  });
  await sendEmail(db, d.email, "You're invited", `Accept your invitation (valid 72 hours): ${baseUrl()}/invite?token=${token}`);
  await db.auditLog.create({
    data: { tenantId: ctx.tenantId, actorId: ctx.userId, requestId: ctx.requestId, action: "user.invite", entityType: "User", after: { email: d.email, role: d.role } },
  });
}

export async function acceptInvite(db: PrismaClient, token: string, input: { name: string; password: string }) {
  const d = z.object({ name: z.string().trim().min(2).max(100), password: passwordSchema }).parse(input);
  const row = await consumeToken(db, "INVITE", token);
  if (!row.email || !row.tenantId || !row.role) throw new AppError("VALIDATION", "This link is invalid or has expired.");
  const passwordHash = await bcrypt.hash(d.password, 12);
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: row.email!, name: d.name, passwordHash, emailVerifiedAt: new Date() }, // token delivery proves the mailbox
    });
    const m = await tx.membership.create({ data: { tenantId: row.tenantId!, userId: user.id, role: row.role! } });
    if (row.propertyIds.length) {
      await tx.userProperty.createMany({ data: row.propertyIds.map((propertyId) => ({ membershipId: m.id, propertyId })) });
    }
    await tx.auditLog.create({
      data: { tenantId: row.tenantId, actorId: user.id, action: "user.invite_accepted", entityType: "User", entityId: user.id },
    });
    return { userId: user.id };
  });
}

// ---------- MFA (TOTP) ----------

export async function beginMfaEnrolment(db: PrismaClient, ctx: Ctx) {
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (user.mfaEnabled) throw new AppError("CONFLICT", "MFA is already enabled.");
  const secret = generateSecret();
  await db.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret) } });
  return { secret, uri: generateURI({ issuer: "MK Hotel PMS", label: user.email, secret }) };
}

export async function confirmMfaEnrolment(db: PrismaClient, ctx: Ctx, code: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!user.mfaSecretEnc || user.mfaEnabled) throw new AppError("VALIDATION", "Start MFA setup first.");
  if (!(await checkTotp(user.mfaSecretEnc, code))) throw new AppError("VALIDATION", "That code is not correct.");
  await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
  await db.auditLog.create({
    data: { tenantId: ctx.tenantId, actorId: ctx.userId, requestId: ctx.requestId, action: "user.mfa_enabled", entityType: "User", entityId: user.id },
  });
}

export async function checkTotp(secretEnc: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const res = await verify({ secret: decryptSecret(secretEnc), token: code.trim(), epochTolerance: 30 });
  return res.valid;
}

/** Admin recovery for a locked-out member. Revokes their sessions and forces re-enrolment. */
export async function resetMemberMfa(db: PrismaClient, ctx: Ctx, targetUserId: string) {
  authorize(ctx, "users.manage");
  await withTenant(db, ctx.tenantId, async (tx) => {
    const m = await tx.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: targetUserId } });
    if (!m) throw new AppError("NOT_FOUND", "Member not found.");
    await audit(tx, ctx, { action: "user.mfa_reset", entityType: "User", entityId: targetUserId });
  });
  await db.user.update({
    where: { id: targetUserId },
    data: { mfaEnabled: false, mfaSecretEnc: null, sessionEpoch: { increment: 1 } },
  });
}

export const mfaRequired = (role: RoleKey) => MFA_REQUIRED_ROLES.includes(role);

// Test helper: current code for a stored secret.
export async function currentTotp(secretEnc: string) {
  return generate({ secret: decryptSecret(secretEnc) });
}
