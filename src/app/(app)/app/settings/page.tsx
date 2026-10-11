import { redirect } from "next/navigation";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

export default async function SettingsHome() {
  const ctx = await getCtx();
  redirect(roleHasPermission(ctx.role, "settings.view", ctx.extra) ? "/app/settings/general" : "/app/settings/tax");
}
