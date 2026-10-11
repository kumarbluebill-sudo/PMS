import Link from "next/link";
import { logoutAction, switchPropertyAction } from "@/app/actions";
import { resendVerificationAction } from "@/app/account-actions";
import { getCtx } from "@/server/session";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";

const NAV: { href: string; label: string; perm: Permission }[] = [
  { href: "/app/dashboard", label: "Dashboard", perm: "rooms.view" },
  { href: "/app/front-desk", label: "Front desk", perm: "frontdesk.checkin" },
  { href: "/app/reservations", label: "Reservations", perm: "reservations.view" },
  { href: "/app/reservations/calendar", label: "Calendar", perm: "reservations.view" },
  { href: "/app/guests", label: "Guests", perm: "guests.view" },
  { href: "/app/billing", label: "Folios", perm: "billing.view" },
  { href: "/app/invoices", label: "Invoices", perm: "billing.view" },
  { href: "/app/credit-notes", label: "Credit notes", perm: "billing.view" },
  { href: "/app/payments", label: "Payments", perm: "billing.view" },
  { href: "/app/cashier", label: "Cashier", perm: "cashier.operate" },
  { href: "/app/invoices/gst-summary", label: "GST summary", perm: "accounting.view" },
  { href: "/app/accounting", label: "Accounting", perm: "accounting.view" },
  { href: "/app/rooms", label: "Rooms", perm: "rooms.view" },
  { href: "/app/room-types", label: "Room types", perm: "rooms.view" },
  { href: "/app/feedback", label: "Feedback", perm: "feedback.view" },
  { href: "/app/housekeeping", label: "Housekeeping", perm: "housekeeping.view" },
  { href: "/app/maintenance", label: "Maintenance", perm: "maintenance.manage" },
  { href: "/app/users", label: "Users", perm: "users.manage" },
  { href: "/app/settings", label: "Settings", perm: "settings.view" },
  { href: "/app/settings/tax", label: "GST & tax", perm: "tax.manage" },
  { href: "/app/audit-logs", label: "Audit log", perm: "audit.view" },
];

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const ctx = await getCtx();
  const props = await withTenant(getDb(), ctx.tenantId, (tx) =>
    tx.property.findMany({ where: { id: { in: ctx.accessiblePropertyIds } }, select: { id: true, name: true } }),
  );
  const nav = NAV.filter((n) => roleHasPermission(ctx.role, n.perm, ctx.extra));
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-slate-200 bg-white p-3 md:w-56 md:border-b-0 md:border-r">
        <div className="mb-3 text-sm font-semibold">MK Hotel PMS</div>
        <form action={switchPropertyAction} className="mb-3">
          <select
            name="propertyId"
            defaultValue={ctx.propertyId ?? ""}
            className="w-full rounded-md border border-slate-300 p-1.5 text-sm"
            aria-label="Property"
          >
            {props.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="mt-1 text-xs underline">Switch</button>
        </form>
        <nav className="flex flex-wrap gap-1 md:flex-col">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
              {n.label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="mt-4">
          <button className="text-xs text-slate-500 underline">
            Sign out ({ctx.role.toLowerCase().replace("_", " ")})
          </button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 bg-slate-50 p-4 md:p-6">
        {!ctx.emailVerified && (
          <form action={resendVerificationAction} className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Your email is not verified. <button className="underline">Resend verification email</button>
          </form>
        )}
        {children}
      </main>
    </div>
  );
}
