import Link from "next/link";
import { addFeedbackNoteAction, recordFeedbackAction, setComplaintStatusAction } from "@/app/feedback-actions";
import { RatingField } from "@/app/RatingField";
import { btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { COMPLAINT_LABELS, COMPLAINT_STATUSES, FEEDBACK_CATEGORIES, LOW_RATING_MAX } from "@/server/domain/feedback";
import { getCtx } from "@/server/session";
import { listRoomTypes } from "@/server/services/rooms";
import { feedbackSummary, listFeedback, type FeedbackFilter } from "@/server/services/feedback";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const stars = (n: number) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;

export default async function FeedbackPage({ searchParams }: PageProps<"/app/feedback">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const canManage = roleHasPermission(ctx.role, "feedback.manage", ctx.extra);
  const rating = one(sp.rating);
  const f: FeedbackFilter = {
    from: DAY.test(one(sp.from)) ? one(sp.from) : undefined,
    to: DAY.test(one(sp.to)) ? one(sp.to) : undefined,
    ...(rating === "low" ? { maxRating: LOW_RATING_MAX } : rating === "high" ? { minRating: 4 } : /^[1-5]$/.test(rating) ? { minRating: Number(rating), maxRating: Number(rating) } : {}),
    reference: one(sp.ref) || undefined,
    status: ["NONE", ...COMPLAINT_STATUSES].includes(one(sp.status)) ? (one(sp.status) as FeedbackFilter["status"]) : undefined,
    roomTypeId: /^[0-9a-f-]{36}$/i.test(one(sp.type)) ? one(sp.type) : undefined,
  };
  const [sum, items, types] = await Promise.all([feedbackSummary(db, ctx, f), listFeedback(db, ctx, f), listRoomTypes(db, ctx)]);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v && k !== "error" && k !== "ok") qs.set(k, v);
  const back = `/app/feedback${qs.toString() ? `?${qs}` : ""}`;
  const recPct = sum.recommendYes + sum.recommendNo ? Math.round((sum.recommendYes / (sum.recommendYes + sum.recommendNo)) * 100) : null;

  const cards: [string, string | number][] = [
    ["Responses", sum.count],
    ["Average rating", sum.average === null ? "—" : `${sum.average} / 5`],
    ["Positive (4–5)", sum.positive],
    ["Low (1–2)", sum.low],
    ["Open complaints", sum.openComplaints],
    ["Would recommend", recPct === null ? "—" : `${recPct}%`],
  ];

  return (
    <>
      <PageHeader title="Guest feedback" subtitle="Ratings and comments from guests. Internal notes stay separate from what the guest wrote." />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      {typeof sp.ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{sp.ok}</p>}
      {sum.openComplaints > 0 && (
        <p role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {sum.openComplaints} low-rating complaint(s) are waiting for follow-up.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {cards.map(([k, v]) => (
          <Card key={k}><div className="text-xs text-slate-500">{k}</div><div className="text-2xl font-semibold">{v}</div></Card>
        ))}
      </div>

      <form method="get" className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-white p-3 md:grid-cols-4 lg:grid-cols-7" aria-label="Feedback filters">
        <label className="text-xs text-slate-600">From<input type="date" name="from" defaultValue={f.from} className={input} /></label>
        <label className="text-xs text-slate-600">To<input type="date" name="to" defaultValue={f.to} className={input} /></label>
        <label className="text-xs text-slate-600">Rating
          <select name="rating" defaultValue={rating} className={input}>
            <option value="">All</option><option value="low">Low (1–2)</option><option value="high">Positive (4–5)</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} only</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Complaint status
          <select name="status" defaultValue={one(sp.status)} className={input}>
            <option value="">All</option>
            {["NONE", ...COMPLAINT_STATUSES].map((s) => <option key={s} value={s}>{COMPLAINT_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Room type
          <select name="type" defaultValue={one(sp.type)} className={input}>
            <option value="">All</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Booking ref<input name="ref" defaultValue={one(sp.ref)} placeholder="MK-…" className={input} /></label>
        <div className="flex items-end gap-2"><button className={btn}>Apply</button><Link href="/app/feedback" className={btnGhost}>Reset</Link></div>
      </form>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Card title="By service category">
          <table className="w-full text-sm"><tbody>
            {sum.categories.map((c) => <tr key={c.key}><td className="py-0.5">{c.label}</td><td className="text-right">{c.average === null ? "—" : `${c.average} / 5`}</td></tr>)}
          </tbody></table>
        </Card>
        <Card title="By property">
          {sum.byProperty.length === 0 ? <p className="text-sm text-slate-500">No responses.</p> : (
            <table className="w-full text-sm"><tbody>
              {sum.byProperty.map((p) => <tr key={p.propertyId}><td className="py-0.5">{p.name}</td><td className="text-right">{p.count} · {p.average ?? "—"}</td></tr>)}
            </tbody></table>
          )}
        </Card>
        <Card title="By room type">
          {sum.byRoomType.length === 0 ? <p className="text-sm text-slate-500">No responses.</p> : (
            <table className="w-full text-sm"><tbody>
              {sum.byRoomType.map((p) => <tr key={p.roomTypeId ?? "none"}><td className="py-0.5">{p.name}</td><td className="text-right">{p.count} · {p.average ?? "—"}</td></tr>)}
            </tbody></table>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {canManage && (
          <Card title="Record feedback for a guest">
            <form action={recordFeedbackAction} className="space-y-3">
              <Field label="Booking reference (optional)"><input name="reference" placeholder="MK-1A2B3C4D" className={input} autoComplete="off" /></Field>
              <Field label="Guest name (if no booking)"><input name="guestName" className={input} /></Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Room"><input name="roomNumber" className={input} /></Field>
                <Field label="Check-in"><input type="date" name="arrival" className={input} /></Field>
                <Field label="Check-out"><input type="date" name="departure" className={input} /></Field>
              </div>
              <RatingField name="overall" label="Overall rating" required />
              {FEEDBACK_CATEGORIES.map((c) => <RatingField key={c.key} name={c.key} label={c.label} />)}
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium text-slate-700">Would recommend us?</legend>
                <label className="mr-4 text-sm"><input type="radio" name="recommend" value="yes" className="mr-1" />Yes</label>
                <label className="text-sm"><input type="radio" name="recommend" value="no" className="mr-1" />No</label>
              </fieldset>
              <Field label="Comments"><textarea name="comments" rows={3} className={input} /></Field>
              <Field label="Suggestions"><textarea name="suggestions" rows={2} className={input} /></Field>
              <button className={btn}>Save feedback</button>
            </form>
          </Card>
        )}
        <div className={`min-w-0 ${canManage ? "lg:col-span-2" : "lg:col-span-3"}`}>
          <Card title={`Recent feedback (${items.length})`}>
            {items.length === 0 ? <p className="text-sm text-slate-500">No feedback matches. Guests can leave feedback through a link created on their reservation.</p> : (
              <ul className="divide-y">
                {items.map((r) => (
                  <li key={r.id} className="space-y-1 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{r.guestName}{r.roomNumber ? ` · Room ${r.roomNumber}` : ""}{r.reference ? ` · ${r.reference}` : ""}</span>
                      <span><span aria-label={`${r.overall} out of 5`}>{stars(r.overall)}</span> <span className="text-xs text-slate-500">{fmtDate(r.submittedAt)} · {r.source === "LINK" ? "guest link" : "entered by staff"}</span></span>
                    </div>
                    {r.comments && <p className="whitespace-pre-wrap">{r.comments}</p>}
                    {r.suggestions && <p className="whitespace-pre-wrap text-slate-600">Suggestion: {r.suggestions}</p>}
                    <p className="text-xs text-slate-500">
                      {FEEDBACK_CATEGORIES.filter((c) => r[c.key] !== null).map((c) => `${c.label} ${r[c.key]}/5`).join(" · ")}
                      {r.recommend !== null && ` · ${r.recommend ? "Would recommend" : "Would not recommend"}`}
                    </p>
                    {r.overall <= LOW_RATING_MAX && (
                      <p className="text-xs"><strong>Complaint:</strong> {COMPLAINT_LABELS[r.status]}</p>
                    )}
                    {canManage && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-slate-600">Follow-up ({r.notes.length} note{r.notes.length === 1 ? "" : "s"})</summary>
                        <div className="mt-2 space-y-2 rounded border border-slate-200 bg-slate-50 p-2">
                          <form action={setComplaintStatusAction} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} />
                            <select name="status" defaultValue={r.status === "NONE" ? "OPEN" : r.status} className="rounded border border-slate-300 p-1" aria-label="Complaint status">
                              {COMPLAINT_STATUSES.map((s) => <option key={s} value={s}>{COMPLAINT_LABELS[s]}</option>)}
                            </select>
                            <button className={btnGhost}>Set status</button>
                          </form>
                          <ul className="space-y-1">
                            {r.notes.map((n) => <li key={n.id}><span className="text-slate-500">{fmtDate(n.createdAt)}</span> {n.note}</li>)}
                          </ul>
                          <form action={addFeedbackNoteAction} className="flex gap-2">
                            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} />
                            <input name="note" required minLength={2} maxLength={2000} placeholder="Internal note (not shown to the guest)" className="min-w-0 flex-1 rounded border border-slate-300 p-1" aria-label="Internal note" />
                            <button className={btnGhost}>Add note</button>
                          </form>
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
