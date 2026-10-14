"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type NavItem = { href: string; label: string; icon: IconName };
export type NavGroup = { label: string; items: NavItem[] };

const ICONS = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  desk: "M4 7h16v4H4zM6 11v8M18 11v8M9 15h6",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  users: "M16 20v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M10 10a3 3 0 100-6 3 3 0 000 6zM20 20v-2a3 3 0 00-2-2.8M16 4.2a3 3 0 010 5.6",
  folio: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  invoice: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6",
  credit: "M4 7h16v10H4zM4 11h16M8 15h3",
  wallet: "M4 7h14a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2zM4 7l12-3v3M16 13h2",
  cash: "M3 7h18v10H3zM12 12m-2.5 0a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M6 10v.01M18 14v.01",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  tax: "M5 19L19 5M7.5 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM16.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  bed: "M3 18V6M3 14h18v4M21 14v-2a3 3 0 00-3-3h-7v5M7 11.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  building: "M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3M3 21h18",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5v.01",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  chat: "M4 5h16v11H9l-5 4z",
  broom: "M14 3l7 7M13 8l-9 9 3 3 9-9M6 15l3 3",
  wrench: "M14.7 6.3a4 4 0 005 5L21 13l-8 8-4-4 8-8zM4 20l3-3",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
} as const;
export type IconName = Exclude<keyof typeof ICONS, "menu" | "close">;

function Icon({ name, className = "h-[18px] w-[18px]" }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The most specific nav item that contains the current path (so Calendar is not also "Reservations"). */
export function activeHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const h of hrefs) {
    if ((pathname === h || pathname.startsWith(`${h}/`)) && (!best || h.length > best.length)) best = h;
  }
  return best;
}

type Props = {
  groups: NavGroup[];
  brand: ReactNode;
  footer: ReactNode;
  children: ReactNode;
};

export default function AppShell({ groups, brand, footer, children }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const active = activeHref(pathname, groups.flatMap((g) => g.items.map((i) => i.href)));

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (open && !desktop) {
      closeBtn.current?.focus();
      document.body.style.overflow = "hidden";
      wasOpen.current = true;
      return () => {
        document.body.style.overflow = "";
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      menuBtn.current?.focus();
    }
  }, [open, desktop]);

  const hidden = !desktop && !open;

  return (
    <div className="min-h-screen lg:flex">
      <header className="app-chrome sticky top-0 z-30 flex items-center justify-between border-b border-brand-800 bg-brand-900 px-4 py-2.5 text-white lg:hidden">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-gold-400 text-sm font-bold text-brand-950">M</span>
          MK Hotel PMS
        </span>
        <button
          ref={menuBtn}
          type="button"
          aria-expanded={open}
          aria-controls="app-sidebar"
          onClick={() => setOpen(true)}
          className="grid h-9 w-9 place-items-center rounded-md hover:bg-brand-800"
        >
          <Icon name="menu" className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </button>
      </header>

      {open && !desktop && <div aria-hidden onClick={() => setOpen(false)} className="app-chrome fixed inset-0 z-40 bg-slate-950/50 lg:hidden" />}

      <aside
        id="app-sidebar"
        aria-label="Main"
        inert={hidden}
        onKeyDown={(e) => e.key === "Escape" && open && setOpen(false)}
        className={`app-chrome fixed inset-y-0 left-0 z-50 flex w-72 flex-col overflow-y-auto bg-brand-900 text-brand-100 transition-transform duration-150 lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:shrink-0 lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full max-lg:invisible"}`}
      >
        <div className="flex items-start justify-between gap-2 px-4 pb-3 pt-4">
          <div className="min-w-0 flex-1">{brand}</div>
          <button ref={closeBtn} type="button" onClick={() => setOpen(false)} className="grid h-8 w-8 shrink-0 place-items-center rounded-md hover:bg-brand-800 lg:hidden">
            <Icon name="close" className="h-5 w-5" />
            <span className="sr-only">Close menu</span>
          </button>
        </div>

        <nav aria-label="Sections" className="flex-1 space-y-4 px-2 pb-4">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-2 pb-1 text-xs font-semibold text-brand-300">{g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((n) => {
                  const isActive = n.href === active;
                  return (
                    <li key={n.href}>
                      <Link
                        href={n.href}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        className={`group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${isActive ? "bg-brand-800 font-medium text-white" : "text-brand-100 hover:bg-brand-800/60 hover:text-white"}`}
                      >
                        {isActive && <span aria-hidden className="absolute -left-2 top-1.5 bottom-1.5 w-1 rounded-r bg-gold-400" />}
                        <span className={isActive ? "text-gold-300" : "text-brand-300 group-hover:text-brand-100"}><Icon name={n.icon} /></span>
                        {n.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="sticky bottom-0 border-t border-brand-800 bg-brand-900 px-4 py-3">{footer}</div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
