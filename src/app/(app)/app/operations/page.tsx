import Link from "next/link";
import { noShowAction } from "@/app/frontoffice-actions";
import { Badge, btn, btnGhost, Card, EmptyState, ErrorBanner, inr, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { operations, type OpsRow } from "@/server/services/frontoffice";
import { getCtx } from "@/server/session";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

type Mode = "arrival" | "inhouse" | "departure" | "plain" | "noshow";

function Rows({ rows, mode, canCancel, canCheckout, canBalances, back }: { rows: (OpsRow & { conflict?: string })[]; mode: Mode; canCancel: boolean; canCheckout: boolean; canBalances: boolean; back: string }) {
  if (rows.length === 0) return <EmptyState title="Nothing here" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr><th>Guest</th><th>Reservation</th><th>Room</th><th>Stay</th><th>Status</th>{canBalances && mode !== "arrival" && <th>Balance</th>}<th>Notes</th><th>Actions</th></tr></thead>
        <tbody className="divide-y">
          {rows.map((o) => (
            <tr key={o.id} className="align-top">
              <th scope="row" className="font-medium">
                {o.guest}
                {o.vip && <span className="ml-1.5 rounded-full bg-gold-100 px-1.5 py-0.5 text-[11px] font-medium text-gold-700">VIP</span>}
              </th>
              <td className="font-mono text-xs"><Link className="underline" href={`/app/reservations/${o.id}`}>{o.reference}</Link></td>
              <td>{o.room ?? <span className="text-amber-800">Not assigned</span>}</td>
              <td className="whitespace-nowrap">{short(o.arrival)} to {short(o.departure)}{o.etaTime && <span className="block text-xs text-slate-500">ETA {o.etaTime}</span>}</td>
              <td><Badge value={o.status} /></td>
              {canBalances && mode !== "arrival" && <td className="whitespace-nowrap tabular-nums">{o.balanceMinor === null ? "—" : inr(o.balanceMinor)}</td>}
              <td className="max-w-56 text-xs text-slate-700">
                {o.conflict && <span className="block font-medium text-red-700">{o.conflict}</span>}
                {o.issues.length > 0 && <span className="block">{o.issues.join(", ")}</span>}
                {o.earlyCheckinRequest && <span className="block">Early check-in: {o.earlyCheckinRequest}</span>}
                {o.lateCheckoutRequest && <span className="block">Late checkout: {o.lateCheckoutRequest}</span>}
                {o.notes && <span className="block truncate" title={o.notes}>{o.notes}</span>}
              </td>
              <td>
                <div className="flex flex-wrap items-start gap-1">
                  {o.status === "CONFIRMED" && <Link href={`/app/check-in/${o.id}`} className={mode === "arrival" ? btn : btnGhost}>Check in</Link>}
                  {o.status === "CHECKED_IN" && canCheckout && <Link href={`/app/check-out/${o.id}`} className={mode === "departure" ? btn : btnGhost}>Checkout</Link>}
                  {["TENTATIVE", "INQUIRY"].includes(o.status) && <Link href={`/app/reservations/${o.id}`} className={btnGhost}>Review</Link>}
                  {mode === "noshow" && canCancel && (
                    <details className="rounded-md border border-slate-300 bg-white">
                      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium">Mark no-show</summary>
                      <form action={noShowAction} className="space-y-2 p-2">
                        <input type="hidden" name="reservationId" value={o.id} />
                        <input type="hidden" name="back" value={back} />
                        <input name="note" required maxLength={200} placeholder="What did you try? (required)" aria-label="No-show note" className={input} />
                        <p className="text-xs text-slate-600">This releases the room and cannot be undone.</p>
                        <button className="rounded-md bg-red-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-800">Confirm no-show</button>
                      </form>
                    </details>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function OperationsPage({ searchParams }: PageProps<"/app/operations">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const rawDate = typeof sp.date === "string" && DAY.test(sp.date) ? sp.date : undefined;
  const o = await operations(getDb(), ctx, { date: rawDate });
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const common = { canCancel: can("reservations.cancel"), canCheckout: can("frontdesk.checkout"), canBalances: o.canSeeBalances, back: `/app/operations${rawDate ? `?date=${rawDate}` : ""}` };

  const sections: { id: string; title: string; hint: string; rows: (OpsRow & { conflict?: string })[]; mode: Mode; tone?: "warn" }[] = [
    { id: "arrivals", title: "Arrivals expected", hint: "Confirmed or checked in, arriving on this date", rows: o.arrivalsExpected, mode: "arrival" },
    { id: "yet-to-arrive", title: "Guests yet to arrive", hint: "Confirmed, not checked in", rows: o.yetToArrive, mode: "arrival" },
    { id: "in-house", title: "Guests in house", hint: "Checked in", rows: o.inHouse, mode: "inhouse" },
    { id: "departures", title: "Departures expected", hint: "Checked-in guests leaving on this date", rows: o.departuresExpected, mode: "departure" },
    { id: "checked-out", title: "Checked out", hint: "Left on this date", rows: o.checkedOutToday, mode: "plain" },
    { id: "overdue", title: "Overdue departures", hint: "Still in house after their departure date", rows: o.overdueDepartures, mode: "departure", tone: "warn" },
    { id: "to-confirm", title: "Reservations needing confirmation", hint: "Tentative or inquiry", rows: o.toConfirm, mode: "plain" },
    { id: "registration", title: "Incomplete registration", hint: "Missing mobile number, ID or registration", rows: o.incompleteRegistration, mode: "arrival" },
    { id: "unpaid", title: "Unpaid balances", hint: "In-house guests who owe money", rows: o.unpaid, mode: "departure" },
    { id: "early", title: "Early check-in requests", hint: "Arriving on this date", rows: o.earlyRequests, mode: "arrival" },
    { id: "late", title: "Late checkout requests", hint: "Leaving on this date", rows: o.lateRequests, mode: "departure" },
    { id: "conflicts", title: "Room allocation conflicts", hint: "Assigned room is out of order or blocked", rows: o.conflicts, mode: "arrival", tone: "warn" },
    { id: "unassigned", title: "Arrivals without a room", hint: "Confirmed but no room allocated", rows: o.unassigned, mode: "arrival", tone: "warn" },
    { id: "vip", title: "VIP and special requests", hint: "VIP guests and bookings with notes arriving on this date", rows: o.vipOrSpecial, mode: "arrival" },
    { id: "no-shows", title: "No-show candidates", hint: `Past arrival date or after ${o.noShowCutoff} today. Staff must review and confirm each one.`, rows: o.noShowCandidates, mode: "noshow", tone: "warn" },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: "Front desk" }, { label: "Today's operations" }]} />
      <PageHeader
        title="Today's operations"
        subtitle={o.date === o.today ? `Business date ${o.date}, local time ${o.now}` : `Viewing ${o.date} (today is ${o.today})`}
        actions={
          <form method="get" className="flex items-center gap-2">
            <input type="date" name="date" defaultValue={o.date} aria-label="Date" className={`${input} w-40`} />
            <button className={btnGhost}>Go</button>
          </form>
        }
      />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      {typeof sp.ok === "string" && <Notice tone="success">{sp.ok}</Notice>}
      <nav aria-label="Worklists" className="mb-4 flex flex-wrap gap-2">
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={`rounded-full border px-3 py-1 text-xs font-medium ${s.rows.length > 0 && s.tone === "warn" ? "border-amber-400 bg-amber-50 text-amber-900" : "border-slate-300 bg-white text-slate-700"} hover:bg-slate-50`}>
            {s.title} <span className="ml-1 font-semibold tabular-nums">{s.rows.length}</span>
          </a>
        ))}
      </nav>
      <div className="space-y-4">
        {sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-20">
            <Card title={`${s.title} (${s.rows.length})`}>
              <p className="-mt-2 mb-2 text-xs text-slate-600">{s.hint}</p>
              <Rows rows={s.rows} mode={s.mode} {...common} />
            </Card>
          </section>
        ))}
      </div>
    </>
  );
}
