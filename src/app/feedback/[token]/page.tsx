import type { Metadata } from "next";
import { submitPublicFeedbackAction } from "@/app/feedback-actions";
import { RatingField } from "@/app/RatingField";
import { btn, ErrorBanner, Field, input } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { FEEDBACK_CATEGORIES } from "@/server/domain/feedback";
import { loadFeedbackLink } from "@/server/services/feedback";

// A private, single-use link: keep it out of search engines.
export const metadata: Metadata = { title: "Share your feedback", robots: { index: false, follow: false } };

const MESSAGES = {
  INVALID: "This feedback link is not valid.",
  EXPIRED: "This feedback link has expired. Please ask the hotel for a new one.",
  USED: "Feedback has already been submitted for this stay. Thank you!",
} as const;

const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default async function PublicFeedback({ params, searchParams }: PageProps<"/feedback/[token]">) {
  const { token } = await params;
  const { error, done } = await searchParams;
  const link = await loadFeedbackLink(getDb(), token);
  return (
    <main className="mx-auto max-w-xl p-4 md:p-8">
      {done === "1" ? (
        <section role="status" className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
          <h1 className="text-xl font-semibold text-green-900">Thank you!</h1>
          <p className="mt-2 text-sm text-green-900">Your feedback has been sent to the hotel.</p>
        </section>
      ) : link.state !== "OK" ? (
        <section className="rounded-lg border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-xl font-semibold">Share your feedback</h1>
          <p className="mt-2 text-sm text-slate-600">{MESSAGES[link.state]}</p>
        </section>
      ) : (
        <form action={submitPublicFeedbackAction} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <input type="hidden" name="token" value={token} />
          <header>
            <h1 className="text-xl font-semibold">How was your stay, {link.firstName}?</h1>
            <p className="text-sm text-slate-600">{link.propertyName} · {fmt(link.arrival)} to {fmt(link.departure)}</p>
          </header>
          <ErrorBanner message={typeof error === "string" ? error : undefined} />
          <RatingField name="overall" label="Overall experience" required />
          {FEEDBACK_CATEGORIES.map((c) => <RatingField key={c.key} name={c.key} label={c.label} />)}
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium text-slate-700">Would you recommend us?</legend>
            <label className="mr-4 text-sm"><input type="radio" name="recommend" value="yes" className="mr-1" />Yes</label>
            <label className="text-sm"><input type="radio" name="recommend" value="no" className="mr-1" />No</label>
          </fieldset>
          <Field label="Comments"><textarea name="comments" rows={3} maxLength={2000} className={input} /></Field>
          <Field label="How could we improve?"><textarea name="suggestions" rows={2} maxLength={2000} className={input} /></Field>
          <button className={btn}>Send feedback</button>
          <p className="text-xs text-slate-500">Your feedback is shared with the hotel team. This link works once.</p>
        </form>
      )}
    </main>
  );
}
