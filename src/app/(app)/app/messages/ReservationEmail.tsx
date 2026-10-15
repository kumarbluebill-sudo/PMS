import { consentAction, sendConfirmationEmailAction } from "./actions";
import { btn, btnGhost, Card, input } from "@/app/ui";

type Props = {
  reservationId: string;
  guestId: string;
  back: string;
  consent: { status: string; source: string } | null;
  hasEmail: boolean;
  testMode: boolean;
  emails: { id: string; toEmail: string; status: string; error: string | null; createdAt: Date; deliveredAt: Date | null }[];
};

const LABEL: Record<string, string> = {
  QUEUED: "Waiting to send", ACCEPTED: "Accepted by the email provider (delivery not confirmed yet)", DELIVERED: "Delivered", BOUNCED: "Bounced", FAILED: "Failed", TEST: "Test mode: nothing was sent", SENT: "Sent",
};

/** Email consent, the send button for the confirmation, and the log of what really happened to each email. */
export default function ReservationEmail({ reservationId, guestId, back, consent, hasEmail, testMode, emails }: Props) {
  const granted = consent?.status === "GRANTED";
  return (
    <Card title="Email">
      {testMode && <p className="mb-2 text-xs text-amber-900">No email provider is connected, so emails are recorded but not sent.</p>}
      <p className="mb-2 text-sm">Consent: <strong>{granted ? "Agreed" : consent ? "Withdrawn" : "Not recorded"}</strong>{consent && <span className="text-slate-700"> ({consent.source})</span>}</p>
      <form action={consentAction} className="mb-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="guestId" value={guestId} /><input type="hidden" name="back" value={back} /><input type="hidden" name="channel" value="EMAIL" />
        <input name="source" required minLength={2} maxLength={120} placeholder="How was consent given?" aria-label="How email consent was given" defaultValue={granted ? consent?.source : ""} className={`${input} max-w-60`} />
        <button name="status" value="GRANTED" className={btnGhost}>Record email consent</button>
        {consent && <button name="status" value="REVOKED" className={btnGhost}>Withdraw</button>}
      </form>
      {!hasEmail && <p className="mb-2 text-xs text-red-800">This guest has no email address.</p>}
      <form action={sendConfirmationEmailAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="reservationId" value={reservationId} /><input type="hidden" name="back" value={back} />
        <button className={btn} disabled={!granted || !hasEmail}>Email the confirmation (PDF attached)</button>
      </form>
      {emails.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Emails sent for this booking">
          {emails.map((e) => (
            <li key={e.id} className="rounded border border-slate-200 p-1.5">
              <span className="font-medium">{LABEL[e.status] ?? e.status}</span> · {e.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
              {e.error && <span className="block text-red-800">{e.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
