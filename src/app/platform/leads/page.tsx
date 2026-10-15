import { leadStatusAction } from "@/app/platform-actions";
import { btnGhost, Card, ErrorBanner, fmtDate, Notice, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { requirePlatform } from "@/server/platform";
import { listLeads } from "@/server/services/platform";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function Leads({ searchParams }: PageProps<"/platform/leads">) {
  const sp = await searchParams;
  const p = await requirePlatform();
  const write = p.role === "PLATFORM_SUPER_ADMIN";
  const leads = await listLeads(getDb(), p);
  return (
    <>
      <PageHeader title="Leads" subtitle="People who asked for a demo or contacted sales from the website." />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      <div className="space-y-3">
        {leads.map((l) => (
          <Card key={l.id} title={`${l.hotel} (${l.name})`} actions={<span className="text-xs text-slate-600">{fmtDate(l.createdAt)} · {l.kind === "DEMO" ? "Demo request" : "Contact"} · {l.status.toLowerCase()}</span>}>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
              <dt className="text-slate-600">Mobile</dt><dd><a className="text-brand-700 hover:underline" href={`tel:${l.mobile}`}>{l.mobile}</a></dd>
              <dt className="text-slate-600">Email</dt><dd><a className="text-brand-700 hover:underline" href={`mailto:${l.email}`}>{l.email}</a></dd>
              <dt className="text-slate-600">Rooms, properties</dt><dd>{l.rooms ?? "-"}, {l.properties ?? "-"}</dd>
              {l.integrations && <><dt className="text-slate-600">Integrations</dt><dd>{l.integrations}</dd></>}
              {l.message && <><dt className="text-slate-600">Message</dt><dd className="whitespace-pre-line">{l.message}</dd></>}
            </dl>
            {write && (
              <form action={leadStatusAction} className="mt-2 flex gap-2">
                <input type="hidden" name="id" value={l.id} />
                {l.status !== "CONTACTED" && <button name="status" value="CONTACTED" className={btnGhost}>Mark contacted</button>}
                {l.status !== "CLOSED" && <button name="status" value="CLOSED" className={btnGhost}>Close</button>}
                {l.status !== "NEW" && <button name="status" value="NEW" className={btnGhost}>Reopen</button>}
              </form>
            )}
          </Card>
        ))}
        {leads.length === 0 && <Card><p className="text-sm text-slate-600">No leads yet.</p></Card>}
      </div>
    </>
  );
}
