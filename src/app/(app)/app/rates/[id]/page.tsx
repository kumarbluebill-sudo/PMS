import { deleteRatePlanAction, duplicateRatePlanAction, ratePlanActiveAction } from "@/app/property-actions";
import { btn, btnGhost, Card, ErrorBanner, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import ConfirmAction from "@/components/ConfirmAction";
import PropertyNav from "@/components/PropertyNav";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { MEAL_LABELS, type MEAL_PLANS } from "@/server/domain/rates";
import { getCtx } from "@/server/session";
import { getRatePlan } from "@/server/services/property";
import RatePlanForm from "../RatePlanForm";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function RatePlanDetail({ params, searchParams }: PageProps<"/app/rates/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCtx();
  const canManage = roleHasPermission(ctx.role, "rates.manage", ctx.extra);
  const d = await getRatePlan(getDb(), ctx, id);
  const p = d.plan;
  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Rate plans", href: "/app/rates" }, { label: p.name }]} />
      <PageHeader
        title={`${p.name} (${p.code})`}
        subtitle={`${MEAL_LABELS[p.mealPlan as (typeof MEAL_PLANS)[number]] ?? p.mealPlan} · ${p.refundable ? "refundable" : "non-refundable"} · priority ${p.priority}`}
        actions={<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.active ? "bg-emerald-50 text-emerald-900" : "bg-slate-200 text-slate-800"}`}>{p.active ? "Active" : "Archived"}</span>}
      />
      <PropertyNav current="rates" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      {canManage ? (
        <Card title="Edit rate plan"><RatePlanForm plan={p} types={d.types} /></Card>
      ) : (
        <Card title="Rates"><p className="text-sm text-slate-700">You can view this plan. Editing needs the rate management permission.</p></Card>
      )}

      {canManage && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card title="Duplicate">
            <p className="mb-2 text-sm text-slate-700">Makes an archived copy to adjust for another season. It cannot clash with this plan until you reactivate it.</p>
            <form action={duplicateRatePlanAction}><input type="hidden" name="id" value={p.id} /><button className={btnGhost}>Duplicate plan</button></form>
          </Card>
          <Card title={p.active ? "Archive" : "Reactivate"}>
            {p.active ? (
              <>
                <p className="mb-2 text-sm text-slate-700">New bookings stop using this plan. The {d.reservations} reservation{d.reservations === 1 ? "" : "s"} already made with it keep their rates.</p>
                <ConfirmAction action={ratePlanActiveAction} fields={{ id: p.id, active: "false", back: `/app/rates/${p.id}` }} label="Archive plan" confirmLabel="Archive" title={`Archive ${p.name}?`} impact="It no longer sets prices for new bookings. Existing bookings are not repriced. Reactivate any time." />
              </>
            ) : (
              <form action={ratePlanActiveAction}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="active" value="true" /><input type="hidden" name="back" value={`/app/rates/${p.id}`} /><button className={btn}>Reactivate plan</button></form>
            )}
          </Card>
          <Card title="Delete">
            {d.reservations > 0 ? (
              <p className="text-sm text-slate-700">This plan was used by {d.reservations} reservation{d.reservations === 1 ? "" : "s"}, so it cannot be deleted. Archive it instead.</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-slate-700">No reservation used this plan, so it can be deleted permanently.</p>
                <ConfirmAction action={deleteRatePlanAction} fields={{ id: p.id }} label="Delete plan" confirmLabel="Delete permanently" title={`Delete ${p.name}?`} impact="The plan and its rates are removed for good. This cannot be undone." />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
