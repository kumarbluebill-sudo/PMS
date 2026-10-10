import Link from "next/link";
import { logoutAction, switchPropertyAction } from "@/app/actions";
import { getCtx } from "@/server/session";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";

const NAV: { href: string; label: string; perm: Permission }[] = [
  { href: "/app/dashboard", label: "Dashboard", perm: "rooms.view" },
  { href: "/app/front-desk", label: "Front desk", perm: "frontdesk.checkin" },
  { href: "/app/reservations", label: "Reservations", perm: "reservations.view" },
  { href: "/app/guests", label: "Guests", perm: "guests.view" },
  { href: "/app/rooms", label: "Rooms", perm: "rooms.view" },
  { href: "/app/room-types", label: "Room types", perm: "rooms.view" },
  { href: "/app/housekeeping", label: "Housekeeping", perm: "housekeeping.view" },
  { href: "/app/maintenance", label: "Maintenance", perm: "maintenance.manage" },
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
      <main className="flex-1 bg-slate-50 p-4 md:p-6">{children}</main>
    </div>
  );
}
