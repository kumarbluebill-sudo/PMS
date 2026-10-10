import { roomStatusAction } from "@/app/actions";
import { Badge, btnGhost, Card, ErrorBanner, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { roleHasPermission } from "@/server/auth/permissions";
import { listHousekeeping } from "@/server/services/housekeeping";

export default async function Housekeeping({ searchParams }: PageProps<"/app/housekeeping">) {
  const { error } = await searchParams;
  const ctx = await getCtx();
  const rooms = await listHousekeeping(getDb(), ctx);
  const canUpdate = roleHasPermission(ctx.role, "housekeeping.update", ctx.extra);
  const canInspect = roleHasPermission(ctx.role, "housekeeping.manage", ctx.extra);
  const next = (s: string) =>
    s === "DIRTY" ? ["CLEANING"] : s === "CLEANING" ? ["CLEAN"] : s === "CLEAN" && canInspect ? ["INSPECTED"] : [];
  return (
    <>
      <PageHeader title="Housekeeping" />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rooms.map((r) => (
          <Card key={r.id}>
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">{r.number}</div>
              <Badge value={r.housekeeping} />
            </div>
            <div className="text-xs text-slate-500">{r.roomType.name}</div>
            {canUpdate && (
              <div className="mt-2 flex flex-wrap gap-1">
                {next(r.housekeeping).map((s) => (
                  <form key={s} action={roomStatusAction}>
                    <input type="hidden" name="roomId" value={r.id} />
                    <input type="hidden" name="status" value={s} />
                    <button className={`${btnGhost} min-h-9`}>Mark {s.toLowerCase()}</button>
                  </form>
                ))}
                {r.housekeeping !== "DIRTY" && (
                  <form action={roomStatusAction}>
                    <input type="hidden" name="roomId" value={r.id} />
                    <input type="hidden" name="status" value="DIRTY" />
                    <button className={`${btnGhost} min-h-9`}>Mark dirty</button>
                  </form>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
