"use client";

import { useActionState } from "react";
import { createFeedbackLinkAction, type LinkResult } from "@/app/feedback-actions";
import { btnGhost } from "@/app/ui";

/** Creates a single-use feedback link for a stay and shows it once. */
export function FeedbackLinkButton({ reservationId }: { reservationId: string }) {
  const [state, action, pending] = useActionState<LinkResult, FormData>(createFeedbackLinkAction, {});
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="reservationId" value={reservationId} />
        <button className={btnGhost} disabled={pending}>{pending ? "Creating…" : "Create feedback link"}</button>
      </form>
      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      {state.url && (
        <div className="space-y-1">
          <label className="block text-xs text-slate-600" htmlFor="feedback-url">Send this link to the guest (shown once, valid until {state.expires}, works once)</label>
          <input id="feedback-url" readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} className="w-full rounded border border-slate-300 bg-slate-50 p-1.5 text-xs" />
        </div>
      )}
    </div>
  );
}
