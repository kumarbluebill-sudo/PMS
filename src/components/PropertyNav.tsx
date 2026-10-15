import Link from "next/link";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

const TABS: { id: string; href: string; label: string; perm: Permission }[] = [
  { id: "overview", href: "/app/property", label: "Overview", perm: "rooms.view" },
  { id: "rooms", href: "/app/rooms", label: "Rooms", perm: "rooms.view" },
  { id: "categories", href: "/app/room-types", label: "Room categories", perm: "rooms.view" },
  { id: "floors", href: "/app/structure", label: "Floors and layout", perm: "rooms.view" },
  { id: "rates", href: "/app/rates", label: "Rate plans", perm: "rooms.view" },
  { id: "settings", href: "/app/settings/property", label: "Property settings", perm: "settings.view" },
];
export type PropertyTab = (typeof TABS)[number]["id"];

/** The six Property Management sections, shown above each of its pages. Tabs the viewer cannot open are left out. */
export default async function PropertyNav({ current }: { current: PropertyTab }) {
  const ctx = await getCtx();
  const tabs = TABS.filter((t) => roleHasPermission(ctx.role, t.perm, ctx.extra));
  return (
    <nav aria-label="Property management" className="mb-4 -mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1">
      {tabs.map((t) => {
        const on = t.id === current;
        return (
          <Link
            key={t.id} href={t.href} aria-current={on ? "page" : undefined}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${on ? "border-brand-700 text-brand-900" : "border-transparent text-slate-700 hover:border-slate-300 hover:text-slate-900"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
