import Link from "next/link";
import type { ReactNode } from "react";

/** Header and footer shared by the public pages (home, pricing, contact). */
export function PublicHeader() {
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4">
      <Link href="/" className="flex items-center gap-2.5 font-semibold text-brand-900">
        <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-brand-900 text-base font-bold text-gold-400">M</span>
        MK Hotel PMS
      </Link>
      <nav aria-label="Main" className="flex items-center gap-1 text-sm">
        <Link href="/pricing" className="rounded-md px-3 py-1.5 font-medium text-brand-800 hover:bg-brand-100">Pricing</Link>
        <Link href="/contact" className="rounded-md px-3 py-1.5 font-medium text-brand-800 hover:bg-brand-100">Contact</Link>
        <Link href="/login" className="rounded-md px-3 py-1.5 font-medium text-brand-800 hover:bg-brand-100">Sign in</Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-slate-600">
      <span>MK Solutions Hotel PMS</span>
      <span className="flex gap-4">
        <Link href="/pricing" className="hover:underline">Pricing</Link>
        <Link href="/contact" className="hover:underline">Contact</Link>
        <Link href="/register" className="hover:underline">Start free trial</Link>
      </span>
    </footer>
  );
}

export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-page">
      <PublicHeader />
      <main>{children}</main>
      <PublicFooter />
    </div>
  );
}
