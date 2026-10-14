import Link from "next/link";
import { btn, Card, EmptyState, input, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { getDb } from "@/server/db/client";
import { globalSearch, type SearchHit } from "@/server/services/search";
import { getCtx } from "@/server/session";

const TITLES: Record<SearchHit["kind"], string> = { RESERVATION: "Reservations", GUEST: "Guests", ROOM: "Rooms" };

export default async function SearchPage({ searchParams }: PageProps<"/app/search">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const ctx = await getCtx();
  const hits = q.length >= 2 ? await globalSearch(getDb(), ctx, q) : [];
  return (
    <>
      <Breadcrumbs items={[{ label: "Front desk" }, { label: "Search" }]} />
      <PageHeader title="Search" subtitle="Guest name, mobile number, reservation number or room number." />
      <form method="get" role="search" className="mb-4 flex max-w-xl gap-2">
        <input name="q" defaultValue={q} autoFocus aria-label="Search" placeholder="Search guests, reservations, rooms" className={input} />
        <button className={btn}>Search</button>
      </form>
      {q.length > 0 && q.length < 2 && <p className="text-sm text-slate-600">Type at least 2 characters.</p>}
      {q.length >= 2 && hits.length === 0 && <EmptyState title={`Nothing found for "${q}"`}>Check the spelling, or try a mobile number or reservation number.</EmptyState>}
      <div className="space-y-4">
        {(["RESERVATION", "GUEST", "ROOM"] as const).map((k) => {
          const rows = hits.filter((h) => h.kind === k);
          return rows.length === 0 ? null : (
            <Card key={k} title={`${TITLES[k]} (${rows.length})`}>
              <ul className="divide-y text-sm">
                {rows.map((h) => (
                  <li key={h.href + h.title}><Link href={h.href} className="flex flex-wrap items-baseline justify-between gap-2 py-2 hover:bg-slate-50"><span className="font-medium">{h.title}</span><span className="text-xs text-slate-600">{h.detail}</span></Link></li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
    </>
  );
}
