"use client";

import { useRef, useState, type ReactNode } from "react";

/**
 * A button that opens a confirmation dialog before a destructive or far-reaching action runs. The dialog explains the
 * impact, can ask for a reason, and only then submits the server action. It is a native <dialog>, so Escape closes it,
 * focus stays inside while it is open and returns to the button afterwards.
 */
export default function ConfirmAction({
  action, fields, title, children: _unused, label, confirmLabel, impact, reasonLabel, tone = "danger", className,
}: {
  action: (fd: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  title: string;
  label: ReactNode;
  confirmLabel: string;
  /** What will change, in plain words (shown in the dialog). */
  impact: ReactNode;
  /** When set, a required reason field is shown and sent as `reason`. */
  reasonLabel?: string;
  tone?: "danger" | "neutral";
  className?: string;
  children?: never;
}) {
  void _unused;
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const cls = "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  const danger = `${cls} border-red-700 bg-red-700 text-white hover:bg-red-800`;
  const neutral = `${cls} border-brand-700 bg-brand-700 text-white hover:bg-brand-800`;
  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()} className={className ?? `${cls} border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>{label}</button>
      <dialog
        ref={ref}
        aria-labelledby={`confirm-title-${fields.id ?? title}`}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-slate-300 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/40"
        onClose={() => setBusy(false)}
      >
        <form action={action} onSubmit={() => setBusy(true)} className="space-y-3 p-4">
          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <h2 id={`confirm-title-${fields.id ?? title}`} className="text-base font-semibold">{title}</h2>
          <div className="text-sm text-slate-700">{impact}</div>
          {reasonLabel && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-slate-700">{reasonLabel}</span>
              <input name="reason" required minLength={3} maxLength={200} autoComplete="off" className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm" />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => ref.current?.close()} className={`${cls} border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>Cancel</button>
            <button disabled={busy} className={tone === "danger" ? danger : neutral}>{busy ? "Working..." : confirmLabel}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
