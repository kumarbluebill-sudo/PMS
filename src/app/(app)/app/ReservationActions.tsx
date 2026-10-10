import { reservationAction } from "@/app/actions";
import { btnGhost } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import type { Ctx } from "@/server/auth/context";

const BUTTONS: { kind: string; label: string; status: string[]; perm: Parameters<typeof roleHasPermission>[1] }[] = [
  { kind: "checkin", label: "Check in", status: ["CONFIRMED"], perm: "frontdesk.checkin" },
  { kind: "checkout", label: "Check out", status: ["CHECKED_IN"], perm: "frontdesk.checkout" },
  { kind: "noshow", label: "No-show", status: ["CONFIRMED"], perm: "reservations.cancel" },
  { kind: "cancel", label: "Cancel", status: ["CONFIRMED"], perm: "reservations.cancel" },
];

export function ReservationActions({ id, status, ctx, back }: { id: string; status: string; ctx: Ctx; back: string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {BUTTONS.filter((b) => b.status.includes(status) && roleHasPermission(ctx.role, b.perm, ctx.extra)).map((b) => (
        <form key={b.kind} action={reservationAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="kind" value={b.kind} />
          <input type="hidden" name="back" value={back} />
          {b.kind === "cancel" && <input type="hidden" name="reason" value="Cancelled by staff" />}
          <button className={btnGhost}>{b.label}</button>
        </form>
      ))}
    </div>
  );
}
