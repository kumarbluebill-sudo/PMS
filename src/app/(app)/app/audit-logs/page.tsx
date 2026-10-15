import Link from "next/link";
import { btn, btnGhost, Card, EmptyState, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { searchAuditLogs } from "@/server/services/audit";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function AuditLogs({ searchParams }: PageProps<"/app/audit-logs">) {
  const sp = await searchParams;
  const f = { action: one(sp.action), entityType: one(sp.entityType), entityId: one(sp.entityId), from: one(sp.from), to: one(sp.to), page: Number(one(sp.page)) || 1 };
  const res = await searchAuditLogs(getDb(), await getCtx(), f);
  const active = (Object.entries(f) as [string, string | number][]).filter(([k, v]) => v && k !== "page");
  const href = (page: number) => `/app/audit-logs?${new URLSearchParams({ ...Object.fromEntries(active.map(([k, v]) => [k, String(v)])), page: String(page) })}`;

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, and why. Append-only: entries cannot be edited or deleted." />
      <Card title="Filter">
        <form method="get" role="search" aria-label="Filter the audit log" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Action contains</span><input name="action" defaultValue={f.action} placeholder="e.g. refund" className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Record type</span>
            <select name="entityType" defaultValue={f.entityType} className={input}><option value="">Any</option>{res.entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">From</span><input type="date" name="from" defaultValue={f.from} className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">To</span><input type="date" name="to" defaultValue={f.to} className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Record id</span><input name="entityId" defaultValue={f.entityId} placeholder="Full id" className={input} /></label>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
            <button className={btn}>Apply</button>
            {active.length > 0 && <Link href="/app/audit-logs" className={btnGhost}>Clear filters</Link>}
          </div>
        </form>
      </Card>

      <div className="mt-4">
        <Card title={`Entries (${res.total})`}>
          {res.rows.length === 0 ? (
            <EmptyState title="No entries match">Widen the dates or clear the filters.</EmptyState>
          ) : (
            <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Audit log table, scrolls sideways">
              <table className="w-full min-w-[48rem] text-left text-sm">
                <thead className="text-xs text-slate-600">
                  <tr><th scope="col" className="py-1 pr-2">Time (UTC)</th><th scope="col" className="pr-2">Who</th><th scope="col" className="pr-2">Action</th><th scope="col" className="pr-2">Record</th><th scope="col">Reason and details</th></tr>
                </thead>
                <tbody className="divide-y">
                  {res.rows.map((l) => (
                    <tr key={l.id} className="align-top">
                      <td className="whitespace-nowrap py-2 pr-2">{l.at.toISOString().replace("T", " ").slice(0, 19)}</td>
                      <td className="pr-2">{l.actor}</td>
                      <td className="pr-2">{l.action}</td>
                      <td className="pr-2 font-mono text-xs">{l.entityType}{l.entityId && <Link className="block underline" href={`/app/audit-logs?entityId=${l.entityId}`}>{l.entityId.slice(0, 8)}</Link>}</td>
                      <td>
                        {l.reason && <span className="block">{l.reason}</span>}
                        {(l.before || l.after) && (
                          <details className="text-xs text-slate-700">
                            <summary className="cursor-pointer">Before and after</summary>
                            <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-2">{JSON.stringify({ before: l.before, after: l.after }, null, 1)}</pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.total > 0 && (
            <nav aria-label="Pages" className="mt-3 flex items-center justify-between text-sm">
              <span className="text-slate-600">Page {res.page} of {res.pages}</span>
              <span className="flex gap-2">
                {res.page > 1 && <Link className={btnGhost} href={href(res.page - 1)}>Previous</Link>}
                {res.page < res.pages && <Link className={btnGhost} href={href(res.page + 1)}>Next</Link>}
              </span>
            </nav>
          )}
        </Card>
      </div>
    </>
  );
}
