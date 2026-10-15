// Creates (or promotes) a platform administrator for the software provider's own console at /platform.
// Usage: DATABASE_URL=... PLATFORM_EMAIL=... PLATFORM_PASSWORD=... [PLATFORM_NAME=...] [PLATFORM_ROLE=PLATFORM_SUPER_ADMIN|SAAS_SUPPORT_ADMIN] tsx scripts/create-platform-admin.ts
// The administrator belongs to a dedicated "MK Solutions Platform" account that has no hotel data. They must turn on
// MFA at first sign-in before the console opens. Run it yourself; nothing creates platform users automatically.
import bcrypt from "bcryptjs";
import { createDb } from "../src/server/db/client";

const TENANT_NAME = "MK Solutions Platform";

async function main() {
  const url = process.env.DATABASE_URL;
  const email = process.env.PLATFORM_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_PASSWORD;
  const role = process.env.PLATFORM_ROLE ?? "PLATFORM_SUPER_ADMIN";
  if (!url || !email || !password) throw new Error("DATABASE_URL, PLATFORM_EMAIL and PLATFORM_PASSWORD are required");
  if (password.length < 12) throw new Error("Use a password of at least 12 characters for a platform administrator.");
  if (role !== "PLATFORM_SUPER_ADMIN" && role !== "SAAS_SUPPORT_ADMIN") throw new Error("PLATFORM_ROLE must be PLATFORM_SUPER_ADMIN or SAAS_SUPPORT_ADMIN");
  const db = createDb(url);
  try {
    const tenant =
      (await db.tenant.findFirst({ where: { legalName: TENANT_NAME } })) ??
      (await db.tenant.create({ data: { legalName: TENANT_NAME, displayName: TENANT_NAME } }));
    const existing = await db.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await db.user.create({
        data: { email, name: process.env.PLATFORM_NAME ?? "Platform administrator", passwordHash: await bcrypt.hash(password, 12), emailVerifiedAt: new Date() },
      }));
    const m = await db.membership.findUnique({ where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } } });
    if (m) await db.membership.update({ where: { id: m.id }, data: { role, active: true } });
    else await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
    await db.auditLog.create({ data: { tenantId: tenant.id, actorId: user.id, action: "platform.admin_created", entityType: "User", entityId: user.id, after: { role } } });
    console.log(`${existing ? "Updated" : "Created"} ${role} ${email}. Sign in at /login, enable MFA when asked, then open /platform.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
