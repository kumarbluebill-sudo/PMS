import Link from "next/link";
import { btnGhost, Card, EmptyState, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Bars, GroupedBars, HBars } from "@/components/charts";
import { getDb } from "@/server/db/client";
import { SOURCE_LABELS } from "@/server/domain/quote";
import { rangeKpis } from "@/server/services/analytics";
import { getCtx } from "@/server/session";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
const KIND_LABEL = { ACTUAL: "actual", LIVE: "today, live", FORECAST: "forecast (estimate)" } as const;

export default async function Analytics({ searchParams }: PageProps<"/app/dashboard/analytics">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const span = [7, 14, 30].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const from = typeof sp.from === "string" && DAY.test(sp.from) ? sp.from : undefined;
  const k = await rangeKpis(getDb(), ctx, { from, days: span });
  const today = k.days.find((d) => d.kind === "LIVE");
  const forecast = k.days.filter((d) => d.kind === "FORECAST");
  const avgForecast = forecast.length ? Math.round((forecast.reduce((t, d) => t + d.occupancyPct, 0) / forecast.length) * 10) / 10 : null;
  const labels = k.days.map((d) => short(d.date));

  return (
    <>
      <Breadcrumbs items={[{ label: "Room board", href: "/app/dashboard" }, { label: "Analytics" }]} />
      <PageHeader
        title="Occupancy and revenue"
        subtitle={`${short(k.from)} to ${short(k.to)} · today is ${short(k.today)}`}
        actions={<div className="flex gap-1.5" role="group" aria-label="Period">{[7, 14, 30].map((n) => <Link key={n} href={`/app/dashboard/analytics?days=${n}${from ? `&from=${from}` : ""}`} aria-current={span === n ? "true" : undefined} className={`${btnGhost} ${span === n ? "!border-brand-700 !bg-brand-700 !text-white" : ""}`}>{n} days</Link>)}</div>}
      />
      <Notice tone="info">Past nights are actuals, tonight is live, and later nights are forecasts based on valid bookings. Room revenue is net of tax; nights not yet posted to a folio use the booked rate and are shown as estimates.</Notice>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4" role="list" aria-label="Key figures">
        {[
          ["Occupancy today", today ? `${today.occupancyPct}%` : "—", today ? `${today.sold} of ${today.sellable} sellable rooms` : "Today is outside this range"],
          [`Expected occupancy, next ${forecast.length} night${forecast.length === 1 ? "" : "s"}`, avgForecast === null ? "—" : `${avgForecast}%`, "Forecast (estimate)"],
          ["ARR", k.totals.arrMinor === null ? "—" : rupees(k.totals.arrMinor), k.revenueVisible ? "Room revenue per room sold" : "Billing access needed"],
          ["RevPAR", k.totals.revparMinor === null ? "—" : rupees(k.totals.revparMinor), k.revenueVisible ? "Room revenue per available room-night" : "Billing access needed"],
        ].map(([t, v, h]) => (
          <div key={t} role="listitem"><Card><div className="text-xs text-slate-600">{t}</div><div className="text-2xl font-semibold tabular-nums text-brand-900">{v}</div><div className="text-[11px] text-slate-500">{h}</div></Card></div>
        ))}
      </div>

      {k.totals.sold === 0 && k.days.every((d) => d.arrivals === 0 && d.departures === 0) ? (
        <EmptyState title="No stays in this period">Bookings and check-ins appear here as soon as they exist.</EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Occupancy by night">
            <Bars title="Occupancy percentage by night" format={(n) => `${n}%`} max={100} data={k.days.map((d, i) => ({ label: labels[i], value: d.occupancyPct, hatched: d.kind === "FORECAST", note: KIND_LABEL[d.kind] }))} caption="Hatched bars are forecasts (estimates), not results." />
          </Card>
          <Card title="Arrivals and departures">
            <GroupedBars title="Arrivals and departures by date" labels={labels} a={k.days.map((d) => d.arrivals)} b={k.days.map((d) => d.departures)} aName="Arrivals" bName="Departures" />
          </Card>
          {k.revenueVisible && (
            <Card title="Room revenue by night">
              <Bars title="Room revenue by night, net of tax" format={rupees} data={k.days.map((d, i) => ({ label: labels[i], value: d.postedMinor ?? 0, extra: d.estimatedMinor ?? 0, note: `Posted ${rupees(d.postedMinor ?? 0)}, estimated ${rupees(d.estimatedMinor ?? 0)}` }))} caption={`Solid = posted to folios (${rupees(k.totals.postedMinor ?? 0)}). Hatched = estimated from booked rates (${rupees(k.totals.estimatedMinor ?? 0)}).`} />
              <p className="mt-2 text-xs text-slate-600">Room revenue excludes taxes, food and other services, and payments collected.</p>
            </Card>
          )}
          <Card title={`Occupancy by floor on ${short(k.today >= k.from && k.today <= k.to ? k.today : k.from)}`}>
            {k.byFloor.length === 0 ? <p className="text-sm text-slate-600">No rooms.</p> : <HBars title="Occupancy by floor" rows={k.byFloor.map((s) => ({ label: s.label, value: s.occupancyPct, detail: `${s.sold}/${s.sellable} · ${s.occupancyPct}%` }))} />}
          </Card>
          <Card title="Occupancy by room category">
            {k.byCategory.length === 0 ? <p className="text-sm text-slate-600">No rooms.</p> : <HBars title="Occupancy by category" rows={k.byCategory.map((s) => ({ label: s.label, value: s.occupancyPct, detail: `${s.sold}/${s.sellable} · ${s.occupancyPct}%` }))} />}
          </Card>
          <Card title="Booking sources (arrivals in this period)">
            {k.sources.length === 0 ? <p className="text-sm text-slate-600">No arrivals in this period.</p> : <HBars title="Booking sources" suffix="" rows={k.sources.map((s) => ({ label: SOURCE_LABELS[s.source] ?? s.source, value: s.count, detail: `${s.count}` }))} />}
          </Card>
        </div>
      )}
    </>
  );
}
