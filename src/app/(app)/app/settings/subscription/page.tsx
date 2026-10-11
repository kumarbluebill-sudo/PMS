import { Card, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

export default async function SubscriptionSettings() {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to these settings.</p>;
  return (
    <>
      <PageHeader title="Subscription" subtitle="Your plan with the software provider." />
      <Card title="Plan">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Current plan</dt><dd>Not configured</dd>
          <dt className="text-slate-500">Billing cycle</dt><dd>—</dd>
          <dt className="text-slate-500">Renewal date</dt><dd>—</dd>
          <dt className="text-slate-500">Plan limits</dt><dd>None enforced</dd>
          <dt className="text-slate-500">Payment status</dt><dd>—</dd>
        </dl>
        <p className="mt-3 text-sm text-slate-700">Plans, entitlements, subscription invoices and upgrades are managed by the platform administrator and are not built yet. Hotel staff, including owners, cannot change plans or feature access from here.</p>
      </Card>
    </>
  );
}
