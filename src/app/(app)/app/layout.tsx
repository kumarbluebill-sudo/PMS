import AppHeader, { type QuickAction } from "@/components/AppHeader";
import AppShell, { type NavGroup, type IconName, type SettingsLink } from "@/components/AppShell";
import { propertyToday } from "@/server/services/roomBlocks";
import { logoutAction, switchPropertyAction } from "@/app/actions";
import { resendVerificationAction } from "@/app/account-actions";
import { getCtx } from "@/server/session";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";

type Def = { href: string; label: string; perm: Permission; icon: IconName };
const GROUPS: { label: string; items: Def[] }[] = [
  {
    label: "Front desk",
    items: [
      { href: "/app/dashboard", label: "Room board", perm: "rooms.view", icon: "home" },
      { href: "/app/operations", label: "Today's operations", perm: "reservations.view", icon: "list" },
      { href: "/app/alerts", label: "Alerts", perm: "reservations.view", icon: "shield" },
      { href: "/app/front-desk", label: "Front desk", perm: "frontdesk.checkin", icon: "desk" },
      { href: "/app/reservations", label: "Reservations", perm: "reservations.view", icon: "list" },
      { href: "/app/reservations/calendar", label: "Calendar", perm: "reservations.view", icon: "calendar" },
      { href: "/app/guests", label: "Guests", perm: "guests.view", icon: "users" },
    ],
  },
  {
    label: "Housekeeping",
    items: [
      { href: "/app/housekeeping", label: "Housekeeping", perm: "housekeeping.view", icon: "broom" },
      { href: "/app/maintenance", label: "Maintenance", perm: "maintenance.manage", icon: "wrench" },
    ],
  },
  {
    label: "Billing",
    items: [
      { href: "/app/billing", label: "Folios", perm: "billing.view", icon: "folio" },
      { href: "/app/invoices", label: "Invoices", perm: "billing.view", icon: "invoice" },
      { href: "/app/credit-notes", label: "Credit notes", perm: "billing.view", icon: "credit" },
      { href: "/app/payments", label: "Payments", perm: "billing.view", icon: "wallet" },
      { href: "/app/cashier", label: "Cashier", perm: "cashier.operate", icon: "cash" },
      { href: "/app/invoices/gst-summary", label: "GST summary", perm: "accounting.view", icon: "tax" },
      { href: "/app/accounting", label: "Accounting", perm: "accounting.view", icon: "chart" },
      { href: "/app/settings/tax", label: "GST & tax", perm: "tax.manage", icon: "tax" },
    ],
  },
  {
    label: "Property",
    items: [
      { href: "/app/property", label: "Property overview", perm: "rooms.view", icon: "building" },
      { href: "/app/rooms", label: "Rooms", perm: "rooms.view", icon: "bed" },
      { href: "/app/room-types", label: "Room categories", perm: "rooms.view", icon: "tag" },
      { href: "/app/structure", label: "Floors and layout", perm: "rooms.view", icon: "building" },
      { href: "/app/rates", label: "Rate plans", perm: "rooms.view", icon: "tax" },
    ],
  },
  {
    label: "Guest care",
    items: [
      { href: "/app/feedback", label: "Feedback", perm: "feedback.view", icon: "star" },
      { href: "/app/messages", label: "WhatsApp", perm: "guests.view", icon: "chat" },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/app/users", label: "Users", perm: "users.manage", icon: "shield" },
      { href: "/app/audit-logs", label: "Audit log", perm: "audit.view", icon: "list" },
    ],
  },
];

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const ctx = await getCtx();
  const props = await withTenant(getDb(), ctx.tenantId, (tx) =>
    tx.property.findMany({ where: { id: { in: ctx.accessiblePropertyIds } }, select: { id: true, name: true } }),
  );
  const groups: NavGroup[] = GROUPS.map((g) => ({
    label: g.label,
    items: g.items.filter((n) => roleHasPermission(ctx.role, n.perm, ctx.extra)).map(({ href, label, icon }) => ({ href, label, icon })),
  })).filter((g) => g.items.length > 0);
  const current = props.find((p) => p.id === ctx.propertyId);
  const can = (p: Permission) => roleHasPermission(ctx.role, p, ctx.extra);
  const businessDate = ctx.propertyId ? await propertyToday(getDb(), ctx) : new Date().toISOString().slice(0, 10);
  const settingsLinks: SettingsLink[] = ([
    ["/app/settings/reservations", "Front office and dashboard", "No-show review time, ID rules, refresh", "settings.view"],
    ["/app/settings/rooms", "Room-status colours", "Names and colours shown on the board", "settings.view"],
    ["/app/settings/general", "Hotel configuration", "Name, contact, time zone, policies", "settings.view"],
    ["/app/property", "Property management", "Rooms, categories, floors, rate plans", "rooms.view"],
    ["/app/settings/property", "Property profile", "Contact, timings, status", "settings.view"],
    ["/app/structure", "Floors and layout", "Where rooms are", "rooms.manage"],
    ["/app/room-types", "Room categories", "Occupancy, rates, amenities", "rooms.manage"],
    ["/app/users", "Users", "Accounts and access", "users.manage"],
    ["/app/settings/permissions", "Roles and permissions", "What each role can do", "settings.view"],
    ["/app/settings/notifications", "Notification preferences", "Alerts and templates", "settings.view"],
    ["/app/settings/billing", "Invoice settings", "Layout, numbering, payment methods", "settings.view"],
    ["/app/settings/invoice-design", "Invoice design", "Themes and live preview", "settings.view"],
    ["/app/settings/tax", "GST and tax", "Rates and registration", "tax.manage"],
    ["/app/settings", "All settings", "Everything else", "settings.view"],
  ] as [string, string, string, Permission][]).filter(([, , , perm]) => can(perm)).map(([href, label, hint]) => ({ href, label, hint }));
  const quick: QuickAction[] = ([
    ["/app/reservations/new", "New reservation", "reservations.create", true],
    [`/app/reservations/new?arrival=${businessDate}`, "Walk-in check-in", "frontdesk.checkin", false],
    ["/app/search", "Guest search", "reservations.view", false],
    ["/app/operations#unassigned", "Room allocation", "reservations.modify", false],
    ["/app/operations#departures", "Check-out", "frontdesk.checkout", false],
    ["/app/payments", "Collect payment", "payments.record", false],
    ["/app/operations#arrivals", "Arrivals", "reservations.view", false],
    ["/app/operations#departures", "Departures", "reservations.view", false],
  ] as [string, string, Permission, boolean][]).filter(([, , perm]) => can(perm)).map(([href, label, , primary]) => ({ href, label, primary }));

  const brand = (
    <div>
      <div className="flex items-center gap-2 text-white">
        <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-gold-400 text-base font-bold text-brand-950">M</span>
        <span className="text-sm font-semibold leading-tight">MK Hotel PMS</span>
      </div>
      <form action={switchPropertyAction} className="mt-3 flex gap-1.5">
        <select
          name="propertyId"
          defaultValue={ctx.propertyId ?? ""}
          className="min-w-0 flex-1 rounded-md border border-brand-700 bg-brand-950 px-2 py-1.5 text-sm text-white"
          aria-label="Property"
        >
          {props.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="rounded-md border border-brand-700 px-2 text-xs text-brand-100 hover:bg-brand-800">Switch</button>
      </form>
      {current && props.length > 1 && <p className="mt-1 truncate text-xs text-brand-300">Viewing {current.name}</p>}
    </div>
  );

  const footer = (
    <form action={logoutAction} className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-xs text-brand-300">{ctx.role.toLowerCase().replaceAll("_", " ")}</span>
      <button className="rounded-md border border-brand-700 px-2.5 py-1 text-xs text-brand-100 hover:bg-brand-800">Sign out</button>
    </form>
  );

  return (
    <AppShell groups={groups} settingsLinks={settingsLinks} brand={brand} footer={footer}>
      <AppHeader hotel={current?.name ?? "MK Hotel PMS"} businessDate={businessDate} role={ctx.role.toLowerCase().replaceAll("_", " ")} actions={quick} />
      <main className="mx-auto w-full max-w-[96rem] bg-page p-4 md:p-6">
        {!ctx.emailVerified && (
          <form action={resendVerificationAction} className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Your email is not verified. <button className="underline">Resend verification email</button>
          </form>
        )}
        {children}
      </main>
    </AppShell>
  );
}
