"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Counts = { critical: number; warning: number; total: number; notifications?: number };

/** Header bell. Fetches the live alert count after load (and every minute) so it never slows page rendering. */
export default function AlertBell() {
  const [c, setC] = useState<Counts | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/alerts/count", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Counts | null) => alive && j && setC(j))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const total = c?.total ?? 0;
  return (
    <Link
      href="/app/alerts"
      className="relative grid h-9 w-9 place-items-center rounded-md text-slate-700 hover:bg-slate-100"
      title={c ? `${total} open alert${total === 1 ? "" : "s"} and notification${total === 1 ? "" : "s"}` : "Alerts"}
    >
      <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M6 17V11a6 6 0 1112 0v6l2 2H4zM10 21h4" /></svg>
      <span className="sr-only">Alerts{c ? `: ${c.critical} critical, ${c.warning} warning, ${c.notifications ?? 0} unread notification${(c.notifications ?? 0) === 1 ? "" : "s"}` : ""}</span>
      {total > 0 && (
        <span aria-hidden className={`absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center text-[10px] font-bold leading-4 text-white ${c && c.critical > 0 ? "bg-red-700" : "bg-amber-700"}`}>{total > 99 ? "99+" : total}</span>
      )}
    </Link>
  );
}
