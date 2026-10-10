import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { AppError } from "@/server/errors";

export const PROPERTY_COOKIE = "pms_property";

/** Resolves the validated request context, or redirects to /login. */
export async function getCtx(): Promise<Ctx> {
  const session = (await auth()) as unknown as { uid?: string; epoch?: number } | null;
  if (!session?.uid) redirect("/login");
  const wanted = (await cookies()).get(PROPERTY_COOKIE)?.value;
  try {
    return await loadContext(getDb(), { userId: session.uid, epoch: session.epoch ?? 0 }, wanted);
  } catch (e) {
    if (e instanceof AppError && e.code === "UNAUTHENTICATED") redirect("/login");
    throw e;
  }
}
