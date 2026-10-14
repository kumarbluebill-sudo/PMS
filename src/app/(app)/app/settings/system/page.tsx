import Link from "next/link";
import { Card, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { twilioConfig } from "@/server/messaging/provider";
import pkg from "../../../../../../package.json";

type Mig = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null };

export default async function SystemSettings() {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to these settings.</p>;
  const db = getDb();
  let dbOk = true;
  let migrations: Mig[] = [];
  try {
    await db.$queryRaw`SELECT 1`;
    migrations = await db.$queryRaw<Mig[]>`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 30`;
  } catch {
    dbOk = false;
  }
  const unfinished = migrations.filter((m) => !m.finished_at || m.rolled_back_at).length;
  return (
    <>
      <PageHeader title="System & audit" subtitle="Application health and the audit trail." />
      <div className="space-y-4">
        <Card title="Health">
          <dl className="grid grid-cols-[12rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Application version</dt><dd>{pkg.version}</dd>
            <dt className="text-slate-500">Database</dt><dd>{dbOk ? "Reachable" : "Not reachable"}</dd>
            <dt className="text-slate-500">Database migrations</dt>
            <dd>{migrations.length === 0 ? "Not visible to the application" : unfinished ? `${unfinished} not finished: needs attention` : `${migrations.length}+ applied, latest ${migrations[0].migration_name}`}</dd>
            <dt className="text-slate-500">WhatsApp (Twilio)</dt>
            <dd>{twilioConfig() ? "Credentials configured. Use the WhatsApp page to send a message and confirm delivery." : "Not configured: running in test mode (nothing is delivered)."}</dd>
            <dt className="text-slate-500">Logo / file storage</dt><dd>{process.env.SUPABASE_SERVICE_ROLE_KEY ? "Configured" : "Not configured (logo uses a web address)"}</dd>
            <dt className="text-slate-500">Email, channel manager, payment gateway</dt><dd>Not built yet</dd>
            <dt className="text-slate-500">Error reports</dt><dd>Not collected in the app. Check the hosting provider&apos;s logs.</dd>
          </dl>
        </Card>
        <Card title="Audit log">
          <p className="text-sm text-slate-700">The audit log is append-only: entries cannot be edited or deleted by anyone using the application, and there is no retention setting that removes them. Sign-in events are listed under <Link className="underline" href="/app/settings/security">Users &amp; security</Link>.</p>
          {roleHasPermission(ctx.role, "audit.view", ctx.extra) && <p className="mt-2 text-sm"><Link className="underline" href="/app/audit-logs">Open the audit log</Link></p>}
        </Card>
      </div>
    </>
  );
}
