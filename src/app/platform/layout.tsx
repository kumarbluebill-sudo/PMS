import type { Metadata } from "next";
import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { requirePlatform } from "@/server/platform";

export const metadata: Metadata = { title: "Platform console", robots: { index: false, follow: false } };

const NAV: [string, string][] = [
  ["/platform", "Overview"],
  ["/platform/subscriptions", "Subscriptions"],
  ["/platform/renewals", "Renewals and overdue"],
  ["/platform/plans", "Plans and add-ons"],
  ["/platform/coupons", "Coupons"],
  ["/platform/leads", "Leads"],
  ["/platform/settings", "Settings"],
];

/** The provider's own console. It does not share the hotel shell, and every page inside requires a platform role. */
export default async function PlatformLayout({ children }: LayoutProps<"/platform">) {
  const p = await requirePlatform();
  return (
    <div className="min-h-screen bg-page">
      <header className="border-b border-slate-200 bg-brand-900 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="flex items-center gap-2.5 font-semibold">
            <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-gold-400 text-base font-bold text-brand-950">M</span>
            MK Solutions platform
          </span>
          <form action={logoutAction} className="flex items-center gap-3 text-sm">
            <span className="text-brand-200">{p.role === "PLATFORM_SUPER_ADMIN" ? "Super admin" : "Support"}</span>
            <button className="rounded-md border border-brand-700 px-2.5 py-1 hover:bg-brand-800">Sign out</button>
          </form>
        </div>
      </header>
      <div className="mx-auto max-w-7xl gap-6 px-4 py-4 lg:flex">
        <nav aria-label="Platform" className="mb-4 flex flex-wrap gap-1 lg:mb-0 lg:w-52 lg:shrink-0 lg:flex-col">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="rounded-md px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-100">{label}</Link>
          ))}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
