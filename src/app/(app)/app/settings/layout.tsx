import Link from "next/link";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

export const SETTINGS_NAV: { href: string; label: string; perm: Permission }[] = [
  { href: "/app/settings/general", label: "General", perm: "settings.view" },
  { href: "/app/settings/property", label: "Property & rooms", perm: "settings.view" },
  { href: "/app/settings/reservations", label: "Reservations", perm: "settings.view" },
  { href: "/app/settings/rooms", label: "Rooms & housekeeping", perm: "settings.view" },
  { href: "/app/settings/billing", label: "Billing & invoices", perm: "settings.view" },
  { href: "/app/settings/tax", label: "GST & tax", perm: "tax.manage" },
  { href: "/app/settings/security", label: "Users & security", perm: "settings.view" },
  { href: "/app/settings/permissions", label: "Roles & permissions", perm: "settings.view" },
  { href: "/app/messages", label: "WhatsApp", perm: "guests.view" },
  { href: "/app/settings/notifications", label: "Notifications", perm: "settings.view" },
  { href: "/app/settings/channels", label: "Channel manager", perm: "settings.view" },
  { href: "/app/settings/reports", label: "Reports", perm: "settings.view" },
  { href: "/app/settings/backup", label: "Backup & recovery", perm: "backup.configure" },
  { href: "/app/settings/subscription", label: "Subscription", perm: "settings.view" },
  { href: "/app/settings/system", label: "System & audit", perm: "settings.view" },
];

export default async function SettingsLayout({ children }: LayoutProps<"/app/settings">) {
  const ctx = await getCtx();
  const nav = SETTINGS_NAV.filter((n) => roleHasPermission(ctx.role, n.perm, ctx.extra));
  return (
    <div className="lg:flex lg:gap-6">
      <nav aria-label="Settings" className="mb-4 flex flex-wrap gap-1 lg:mb-0 lg:w-52 lg:shrink-0 lg:flex-col">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className="rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100">{n.label}</Link>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
