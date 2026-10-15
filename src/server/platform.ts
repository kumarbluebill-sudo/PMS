import { notFound } from "next/navigation";
import { getCtx } from "@/server/session";
import type { PlatformCtx } from "@/server/services/platform";

/**
 * Gate for the provider's console. Only the two platform roles pass, and both must have MFA on (getCtx sends anyone
 * without it to the security page). Everyone else, including hotel owners, gets a plain "not found".
 */
export async function requirePlatform(): Promise<PlatformCtx> {
  const ctx = await getCtx();
  if (ctx.role !== "PLATFORM_SUPER_ADMIN" && ctx.role !== "SAAS_SUPPORT_ADMIN") notFound();
  return { userId: ctx.userId, role: ctx.role, requestId: ctx.requestId };
}
