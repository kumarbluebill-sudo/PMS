import { approveShiftAction, closeShiftAction, openShiftAction } from "@/app/billing-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { listShifts } from "@/server/services/payments";

export default async function Cashier({ searchParams }: PageProps<"/app/cashier">) {
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const shifts = await listShifts(getDb(), ctx);
  const mine = shifts.find((s) => s.status === "OPEN" && s.openedBy === ctx.userId);
  const canApprove = roleHasPermission(ctx.role, "cashier.approve", ctx.extra);
  return (
    <>
      <PageHeader title="Cashier" subtitle="Expected cash = opening cash + cash payments - cash refunds in your shift." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 text-sm text-green-800">{ok}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {!mine ? (
          <Card title="Open your shift">
            <form action={openShiftAction} className="space-y-3">
              <Field label="Opening cash (₹)"><input name="opening" inputMode="decimal" defaultValue="0" className={input} /></Field>
              <button className={btn}>Open shift</button>
            </form>
          </Card>
        ) : (
          <Card title="Close your shift">
            <p className="mb-2 text-sm">Expected cash now: <strong className="font-mono">{formatInr(mine.live!.expectedMinor)}</strong></p>
            <ul className="mb-3 text-xs text-slate-600">
              {Object.entries(mine.live!.totals).map(([m, v]) => <li key={m}>{m}: {formatInr(v)}</li>)}
            </ul>
            <form action={closeShiftAction} className="space-y-3">
              <Field label="Counted cash (₹)"><input name="counted" required inputMode="decimal" className={input} /></Field>
              <Field label="Variance reason (required if counted differs)"><input name="varianceReason" className={input} /></Field>
              <button className={btn}>Close shift</button>
            </form>
          </Card>
        )}
        <Card title="Recent shifts">
          <ul className="divide-y text-sm">
            {shifts.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {s.openedAt.toISOString().slice(0, 16).replace("T", " ")} · {s.status.toLowerCase()}
                  {s.status === "CLOSED" && (
                    <span className="block text-xs text-slate-500">
                      expected {formatInr(s.expectedMinor ?? 0)}, counted {formatInr(s.countedMinor ?? 0)}, variance {formatInr(s.varianceMinor ?? 0)}
                      {s.varianceReason ? ` (${s.varianceReason})` : ""} · {s.approvedBy ? "approved" : "awaiting approval"}
                    </span>
                  )}
                </span>
                {canApprove && s.status === "CLOSED" && !s.approvedBy && s.closedBy !== ctx.userId && (
                  <form action={approveShiftAction}><input type="hidden" name="shiftId" value={s.id} /><button className={btnGhost}>Approve</button></form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
