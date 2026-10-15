import Link from "next/link";
import { btn } from "@/app/ui";
import { PublicFooter, PublicHeader } from "@/components/PublicChrome";

const TILES: { n: string; label: string; cls: string }[] = [
  { n: "101", label: "Available", cls: "border-green-400 bg-green-50 text-green-900" },
  { n: "102", label: "Occupied", cls: "border-blue-400 bg-blue-50 text-blue-900" },
  { n: "103", label: "Due out", cls: "border-orange-400 bg-orange-50 text-orange-900" },
  { n: "104", label: "Cleaning", cls: "border-slate-400 bg-slate-100 text-slate-900" },
  { n: "201", label: "Occupied", cls: "border-blue-400 bg-blue-50 text-blue-900" },
  { n: "202", label: "Reserved", cls: "border-yellow-400 bg-yellow-50 text-yellow-900" },
  { n: "203", label: "Available", cls: "border-green-400 bg-green-50 text-green-900" },
  { n: "204", label: "Out of order", cls: "border-red-400 bg-red-50 text-red-900" },
];

const FEATURES = [
  ["Front desk in fewer clicks", "Find a room, open the reservation, check in or out and print the receipt without hunting through menus."],
  ["GST billing you can audit", "Gapless invoice numbers, credit notes, and a ledger that cannot be edited after the fact."],
  ["Set up your own way", "Buildings, floors, room categories, status colours and document layouts are all yours to configure."],
];

export default function Home() {
  return (
    <div className="min-h-screen bg-page">
      <PublicHeader />
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 md:grid-cols-2 md:py-20">
          <div>
            <h1 className="text-4xl font-semibold leading-tight text-slate-900 md:text-5xl">Run your hotel from one clear room board.</h1>
            <p className="mt-4 max-w-md text-base text-slate-600">Rooms, reservations, front desk, housekeeping and GST billing for hotels and resorts in India.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/register" className={`${btn} px-5 py-2.5`}>Start free trial</Link>
              <Link href="/pricing" className="inline-flex items-center rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50">See pricing</Link>
              <Link href="/login" className="inline-flex items-center rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50">Sign in</Link>
            </div>
          </div>
          <div aria-hidden className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_8px_30px_rgba(10,61,58,0.10)]">
            <div className="mb-3 flex items-center justify-between text-xs text-slate-600">
              <span className="font-medium text-slate-900">Room board</span>
              <span>Today</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {TILES.map((t) => (
                <div key={t.n} className={`rounded-md border-2 p-2 ${t.cls}`}>
                  <div className="text-base font-semibold">{t.n}</div>
                  <div className="text-xs">{t.label}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="border-t border-slate-200 bg-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 md:grid-cols-3">
            {FEATURES.map(([t, d]) => (
              <div key={t}>
                <h2 className="text-base font-semibold text-slate-900">{t}</h2>
                <p className="mt-1.5 text-sm text-slate-600">{d}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
