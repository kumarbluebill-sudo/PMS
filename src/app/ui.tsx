import type { ReactNode } from "react";

export const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-700 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50";
export const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-800 disabled:opacity-50";
export const input =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-slate-100";
/** Shared table look: pair with <thead className={thead}> and divide-y on the body. */
export const thead = "bg-slate-50 text-xs font-medium text-slate-600";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <span aria-hidden className="mt-0.5 font-bold">!</span>
      <span>{message}</span>
    </p>
  );
}

const noticeTone = {
  success: "border-green-200 bg-green-50 text-green-900",
  info: "border-brand-200 bg-brand-50 text-brand-900",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
} as const;

/** Non-error message. Success and info use role="status"; warnings are announced the same way. */
export function Notice({ tone = "info", children }: { tone?: keyof typeof noticeTone; children: ReactNode }) {
  return (
    <p role="status" className={`mb-3 rounded-md border px-3 py-2 text-sm ${noticeTone[tone]}`}>
      {children}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(26,32,26,0.05)]">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const tone: Record<string, string> = {
  CONFIRMED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-green-100 text-green-800",
  CHECKED_OUT: "bg-slate-100 text-slate-700",
  CANCELLED: "bg-red-100 text-red-800",
  NO_SHOW: "bg-amber-100 text-amber-800",
  CLEAN: "bg-green-100 text-green-800",
  INSPECTED: "bg-emerald-100 text-emerald-800",
  DIRTY: "bg-amber-100 text-amber-800",
  CLEANING: "bg-sky-100 text-sky-800",
};

export function Badge({ value }: { value: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone[value] ?? "bg-slate-100 text-slate-700"}`}>
      {value.replace("_", " ").toLowerCase()}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold leading-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 max-w-prose text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
export const inr = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
