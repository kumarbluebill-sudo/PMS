import { reservationAction } from "@/app/actions";
import { openFolioAction } from "@/app/billing-actions";
import { btnGhost } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import type { Ctx } from "@/server/auth/context";

const BUTTONS: { kind: string; label: string; status: string[]; perm: Parameters<typeof roleHasPermission>[1] }[] = [
  { kind: "confirm", label: "Confirm", status: ["TENTATIVE"], perm: "reservations.modify" },
  { kind: "checkin", label: "Check in", status: ["CONFIRMED"], perm: "frontdesk.checkin" },
  { kind: "checkout", label: "Check out", status: ["CHECKED_IN"], perm: "frontdesk.checkout" },
  { kind: "noshow", label: "No-show", status: ["CONFIRMED"], perm: "reservations.cancel" },
  { kind: "cancel", label: "Cancel", status: ["CONFIRMED", "TENTATIVE"], perm: "reservations.cancel" },
];

export function ReservationActions({ id, status, ctx, back, only }: { id: string; status: string; ctx: Ctx; back: string; only?: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {BUTTONS.filter((b) => (!only || only.includes(b.kind)) && b.status.includes(status) && roleHasPermission(ctx.role, b.perm, ctx.extra)).map((b) => (
        <form key={b.kind} action={reservationAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="kind" value={b.kind} />
          <input type="hidden" name="back" value={back} />
          {b.kind === "cancel" && <input type="hidden" name="reason" value="Cancelled by staff" />}
          {b.kind === "checkout" && roleHasPermission(ctx.role, "billing.waive", ctx.extra) && (
            <input name="waive" placeholder="Waive balance: reason" className="mr-1 w-36 rounded border border-slate-300 p-1 text-xs" aria-label="Reason to waive outstanding balance" />
          )}
          <button className={btnGhost}>{b.label}</button>
        </form>
      ))}
      {roleHasPermission(ctx.role, "billing.view", ctx.extra) && ["TENTATIVE", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"].includes(status) && (
        <form action={openFolioAction}>
          <input type="hidden" name="reservationId" value={id} />
          <button className={btnGhost}>Folio</button>
        </form>
      )}
    </div>
  );
}
