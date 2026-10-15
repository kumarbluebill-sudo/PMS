"use client";

import { useEffect, useId, useRef, useState } from "react";

type Match = { id: string; name: string; phone: string | null; email: string | null; lastStay: string | null; stays: number; duplicate: boolean };
type History = {
  totalStays: number; lastVisit: string | null; outstandingMinor: number | null; preferences: string | null; notes: string | null;
  guest: { nationality: string | null; companyName: string | null };
  reservations: { id: string; reference: string; status: string; arrival: string; departure: string; category: string; room: string | null }[];
};
type Phase = "idle" | "loading" | "results" | "none" | "error";

const field = "w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm";
const money = (m: number) => `₹${(m / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

/**
 * Guest recognition for the reservation form. Typing a mobile number (any format) or a name searches existing
 * guests after a short pause; staff pick the right person or create a new guest. Nothing is merged: choosing a guest
 * only fills this booking, and an edited phone is a separate, explicit profile change made on the guest page.
 */
export default function GuestPicker({ canLookup, canCreate }: { canLookup: boolean; canCreate: boolean }) {
  const id = useId();
  const [mobile, setMobile] = useState("");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [matches, setMatches] = useState<Match[]>([]);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<Match | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [creating, setCreating] = useState(false);
  const [differentPerson, setDifferentPerson] = useState(false);
  const [active, setActive] = useState(-1);
  const lastQuery = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  function schedule(q: string) {
    lastQuery.current = q;
    if (timer.current) clearTimeout(timer.current);
    abort.current?.abort();
    const digits = q.replace(/\D/g, "");
    const looksLikePhone = /^[+\d\s\-()]+$/.test(q.trim());
    if (!canLookup || chosen || (looksLikePhone ? digits.length < 4 : q.trim().length < 3)) {
      setPhase("idle"); setMatches([]);
      return;
    }
    setPhase("loading");
    timer.current = setTimeout(async () => {
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const res = await fetch(`/api/guests/lookup?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal, headers: { accept: "application/json" } });
        const body = (await res.json().catch(() => ({}))) as { results?: Match[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Guest search is not available right now.");
        if (lastQuery.current !== q) return;
        setMatches(body.results ?? []);
        setActive(-1);
        setPhase((body.results ?? []).length ? "results" : "none");
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Guest search is not available right now.");
        setPhase("error");
      }
    }, 300);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); abort.current?.abort(); }, []);

  async function choose(m: Match) {
    setChosen(m); setCreating(false); setPhase("idle"); setMatches([]); setHistory(null); setHistoryError("");
    if (m.phone) setMobile(m.phone);
    setName(m.name);
    try {
      const res = await fetch(`/api/guests/${m.id}/history`, { headers: { accept: "application/json" } });
      const body = (await res.json().catch(() => ({}))) as History & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "History is not available.");
      setHistory(body);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : "History is not available.");
    }
  }
  function clear() { setChosen(null); setHistory(null); setHistoryError(""); setMobile(""); setName(""); setPhase("idle"); setDifferentPerson(false); }

  const listId = `${id}-list`;
  const showList = phase === "results" || phase === "none";

  return (
    <div className="space-y-3 md:col-span-2">
      {chosen && <input type="hidden" name="guestId" value={chosen.id} />}
      {!chosen && matches.length > 0 && differentPerson && <input type="hidden" name="allowDuplicate" value="on" />}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="relative">
          <label htmlFor={`${id}-mobile`} className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Mobile number</span>
          </label>
          <input
            id={`${id}-mobile`} name="g_mobile" type="tel" inputMode="tel" autoComplete="off" value={mobile} readOnly={!!chosen?.phone}
            role={canLookup ? "combobox" : undefined} aria-expanded={canLookup ? showList : undefined} aria-controls={canLookup ? listId : undefined} aria-autocomplete={canLookup ? "list" : undefined}
            aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
            onChange={(e) => { setMobile(e.target.value); schedule(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && matches.length) { e.preventDefault(); setActive((a) => Math.min(matches.length - 1, a + 1)); }
              else if (e.key === "ArrowUp" && matches.length) { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter" && active >= 0) { e.preventDefault(); void choose(matches[active]); }
              else if (e.key === "Escape") { setPhase("idle"); setMatches([]); }
            }}
            className={field}
          />
          {chosen && !chosen.phone && <p className="mt-1 text-xs text-slate-600">This guest has no number on file; the number you enter is saved to their profile.</p>}
        </div>
        <div>
          <label htmlFor={`${id}-name`} className="block space-y-1"><span className="text-sm font-medium text-slate-700">Guest name</span></label>
          <input id={`${id}-name`} name="g_name" autoComplete="off" value={name} readOnly={!!chosen} onChange={(e) => { setName(e.target.value); schedule(e.target.value); }} className={field} />
        </div>
      </div>

      <div aria-live="polite" className="text-sm">
        {phase === "loading" && <p className="text-slate-600">Searching guests…</p>}
        {phase === "error" && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-red-900">{error} You can still create a new guest below.</p>}
        {phase === "none" && !creating && (
          <p className="rounded border border-slate-300 bg-slate-50 p-2 text-slate-800">
            No existing guest found. {canCreate ? "A new guest will be created when you save the booking." : "You do not have permission to create guests."}
          </p>
        )}
      </div>

      {showList && matches.length > 0 && !chosen && (
        <ul id={listId} role="listbox" aria-label="Matching guests" className="divide-y rounded-md border border-slate-300 bg-white shadow-sm">
          {matches.map((m, i) => (
            <li key={m.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}>
              <button type="button" onClick={() => void choose(m)} className={`flex w-full flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-left text-sm hover:bg-brand-50 ${i === active ? "bg-brand-50" : ""}`}>
                <span>
                  <strong>{m.name}</strong>
                  <span className="ml-2 text-slate-700">{[m.phone, m.email].filter(Boolean).join(" · ") || "No contact details"}</span>
                </span>
                <span className="text-xs text-slate-600">{m.stays > 0 ? `${m.stays} stay${m.stays === 1 ? "" : "s"}, last ${m.lastStay}` : "No previous stays"}</span>
                {m.duplicate && <span className="w-full text-xs font-medium text-amber-900">Another profile shares this number. Check you are choosing the right person.</span>}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button type="button" onClick={() => { setCreating(true); setPhase("idle"); }} className="w-full px-3 py-2 text-left text-sm font-medium text-brand-800 hover:bg-brand-50">
                None of these: create a new guest
              </button>
            </li>
          )}
        </ul>
      )}

      {!chosen && matches.length > 0 && (
        <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
          <input type="checkbox" checked={differentPerson} onChange={(e) => setDifferentPerson(e.target.checked)} className="mt-1" />
          <span>Tick only if the person you are booking is different from the matches above. A separate profile is then created; profiles are never merged automatically. Otherwise choose a match.</span>
        </label>
      )}

      {chosen && (
        <section aria-label="Selected guest and history" className="rounded-lg border border-brand-200 bg-brand-50/50 p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p><strong>{chosen.name}</strong>, existing guest. This booking uses their profile.</p>
            <span className="flex gap-3 text-xs">
              <a className="underline" href={`/app/guests/${chosen.id}`} target="_blank" rel="noreferrer">Edit profile (opens in a new tab)</a>
              <button type="button" onClick={clear} className="underline">Choose a different guest</button>
            </span>
          </div>
          {!history && !historyError && <p className="mt-2 text-slate-600">Loading history…</p>}
          {historyError && <p className="mt-2 text-slate-700">{historyError}</p>}
          {history && (
            <div className="mt-2 space-y-1">
              <p>{history.totalStays} previous stay{history.totalStays === 1 ? "" : "s"}{history.lastVisit ? `, last visit ${history.lastVisit}` : ""}{history.guest.nationality ? ` · ${history.guest.nationality}` : ""}{history.guest.companyName ? ` · ${history.guest.companyName}` : ""}</p>
              {history.preferences && <p><span className="font-medium">Preferences:</span> {history.preferences}</p>}
              {history.notes && <p><span className="font-medium">Notes:</span> {history.notes}</p>}
              {history.outstandingMinor !== null && history.outstandingMinor > 0 && <p className="font-medium text-amber-900">Open balance on current stays: {money(history.outstandingMinor)}</p>}
              {history.reservations.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                  {history.reservations.slice(0, 5).map((r) => (
                    <li key={r.id}><a className="underline" href={`/app/reservations/${r.id}`} target="_blank" rel="noreferrer">{r.reference}</a> · {r.arrival} to {r.departure} · {r.category}{r.room ? ` · room ${r.room}` : ""} · {r.status.replace("_", " ").toLowerCase()}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="mt-2 text-xs text-slate-600">Special requests for this stay go in the booking notes. Changes to the guest&rsquo;s own details are made on their profile and apply to every booking.</p>
        </section>
      )}
    </div>
  );
}
