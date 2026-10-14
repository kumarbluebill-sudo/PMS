import type { ReactNode } from "react";

const POINTS = [
  "Live room board with arrivals, departures and cleaning status",
  "GST invoices, receipts and folios that stay consistent",
  "Guest messages and feedback in the same place",
];

/** Two-panel layout for sign-in and account screens. The form side is the page's main landmark. */
export default function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="flex flex-col justify-between gap-6 bg-brand-900 px-6 py-5 text-brand-100 md:min-h-screen md:px-10 md:py-10">
        <div className="flex items-center gap-2.5 text-white">
          <span aria-hidden className="grid h-9 w-9 place-items-center rounded-md bg-gold-400 text-lg font-bold text-brand-950">M</span>
          <span className="text-base font-semibold">MK Hotel PMS</span>
        </div>
        <div className="hidden md:block">
          <p className="max-w-sm text-3xl font-semibold leading-tight text-white">Every room, guest and bill in one place.</p>
          <ul className="mt-6 max-w-sm space-y-3 text-sm">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-2.5">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gold-400" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="hidden text-xs text-brand-300 md:block">Built for hotels and resorts in India.</p>
      </div>
      <main className="flex items-center justify-center px-4 py-10 md:px-10">
        <div className={`flex w-full flex-col gap-4 ${wide ? "max-w-md" : "max-w-sm"}`}>{children}</div>
      </main>
    </div>
  );
}
