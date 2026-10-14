import Link from "next/link";
import AlertBell from "./AlertBell";

export type QuickAction = { href: string; label: string; primary?: boolean };

/** Compact top bar: hotel and business date, search, alerts bell, profile, and the quick-action bar. */
export default function AppHeader({ hotel, businessDate, role, actions }: { hotel: string; businessDate: string; role: string; actions: QuickAction[] }) {
  const day = new Date(`${businessDate}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <div className="app-chrome sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur lg:top-0">
      <div className="flex items-center gap-3 px-4 py-2 md:px-6">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{hotel}</p>
          <p className="text-xs text-slate-600">Business date: <time dateTime={businessDate}>{day}</time></p>
        </div>
        <form action="/app/search" method="get" role="search" className="mx-auto hidden w-full max-w-md md:block">
          <label className="sr-only" htmlFor="header-search">Search guests, reservations and rooms</label>
          <input id="header-search" name="q" minLength={2} placeholder="Search guest, reservation or room" className="w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm placeholder:text-slate-500 focus:border-brand-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </form>
        <div className="ml-auto flex items-center gap-1">
          <Link href="/app/search" className="grid h-9 w-9 place-items-center rounded-md text-slate-700 hover:bg-slate-100 md:hidden">
            <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" className="h-5 w-5"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>
            <span className="sr-only">Search</span>
          </Link>
          <AlertBell />
          <Link href="/security" title={`Your account (${role})`} className="grid h-9 w-9 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-900 hover:bg-brand-200">
            <span aria-hidden>{role.slice(0, 2).toUpperCase()}</span>
            <span className="sr-only">Your account and security, signed in as {role}</span>
          </Link>
        </div>
      </div>
      {actions.length > 0 && (
        <nav aria-label="Quick actions" className="flex gap-2 overflow-x-auto border-t border-slate-100 px-4 py-1.5 md:px-6">
          {actions.map((a) => (
            <Link key={a.label} href={a.href} className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${a.primary ? "bg-brand-700 text-white hover:bg-brand-800" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>{a.label}</Link>
          ))}
        </nav>
      )}
    </div>
  );
}
