import { consentAction, sendMessageAction } from "./actions";
import { btn, btnGhost, Card, input } from "@/app/ui";
import { TEMPLATE_KEYS, TEMPLATE_LABELS } from "@/server/messaging/templates";

type Props = {
  reservationId: string;
  guestId: string;
  back: string;
  consent: { status: string; source: string } | null;
  hasPhone: boolean;
  testMode: boolean;
};

/** Consent and send controls shown on a reservation. */
export default function ReservationMessages({ reservationId, guestId, back, consent, hasPhone, testMode }: Props) {
  const granted = consent?.status === "GRANTED";
  return (
    <Card title="WhatsApp">
      {testMode && <p className="mb-2 text-xs text-amber-800">Test mode: messages are recorded but not delivered.</p>}
      <p className="mb-2 text-sm">
        Consent: <strong>{granted ? "Agreed" : consent ? "Withdrawn" : "Not recorded"}</strong>
        {consent && <span className="text-slate-500"> ({consent.source})</span>}
      </p>
      <form action={consentAction} className="mb-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="guestId" value={guestId} />
        <input type="hidden" name="back" value={back} />
        <input name="source" required minLength={2} maxLength={120} placeholder="How was consent given?" aria-label="How consent was given" defaultValue={granted ? consent?.source : ""} className={`${input} max-w-60`} />
        <button name="status" value="GRANTED" className={btnGhost}>Record consent</button>
        {consent && <button name="status" value="REVOKED" className={btnGhost}>Withdraw</button>}
      </form>
      {!hasPhone && <p className="mb-2 text-xs text-red-700">This guest has no mobile number.</p>}
      <form action={sendMessageAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="back" value={back} />
        <select name="templateKey" aria-label="Message" className={`${input} max-w-64`}>
          {TEMPLATE_KEYS.map((k) => <option key={k} value={k}>{TEMPLATE_LABELS[k]}</option>)}
        </select>
        <button className={btn} disabled={!granted || !hasPhone}>Send</button>
      </form>
    </Card>
  );
}
