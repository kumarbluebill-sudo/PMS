import { DISPLAY_STATUSES, STATUS_META, type DisplayStatus } from "@/server/domain/roomStatus";
import type { StatusMeta } from "@/server/domain/settings";

/** Status is shown with an icon and a text label as well as colour. */
export function RoomStatusChip({ status, meta = STATUS_META }: { status: DisplayStatus; meta?: StatusMeta }) {
  const m = meta[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${m.chip}`} title={m.hint}>
      <span aria-hidden="true">{m.icon}</span>
      {m.label}
    </span>
  );
}

export function RoomStatusLegend({ meta = STATUS_META }: { meta?: StatusMeta }) {
  return (
    <ul aria-label="Room status legend" className="flex flex-wrap gap-2">
      {DISPLAY_STATUSES.map((s) => (
        <li key={s} className="flex items-center gap-1 text-xs text-slate-600">
          <RoomStatusChip status={s} meta={meta} />
          <span className="hidden sm:inline">{meta[s].hint}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The status key for the room board: every status with its colour swatch, icon, label, hint and a live room count.
 * Each row filters the board to that status. Colour is never the only signal.
 */
export function StatusKey({
  meta = STATUS_META,
  counts,
  active,
  hrefFor,
}: {
  meta?: StatusMeta;
  counts: Record<DisplayStatus, number>;
  active?: DisplayStatus;
  hrefFor: (status: DisplayStatus | null) => string;
}) {
  return (
    <ul aria-label="Room status legend" className="space-y-1">
      {DISPLAY_STATUSES.map((s) => {
        const m = meta[s];
        const on = active === s;
        return (
          <li key={s}>
            <a
              href={hrefFor(on ? null : s)}
              aria-current={on ? "true" : undefined}
              aria-label={`${m.label}: ${counts[s]} room${counts[s] === 1 ? "" : "s"}. ${on ? "Showing only these. Select to show all." : "Select to show only these."}`}
              className={`flex items-center gap-2.5 rounded-md border px-2 py-1.5 transition-colors hover:bg-slate-50 ${on ? "border-brand-600 bg-brand-50" : "border-transparent"}`}
            >
              <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border-2 text-sm ${m.cell}`}>{m.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-900">{m.label}</span>
                <span className="block truncate text-xs text-slate-600" title={m.hint}>{m.hint}</span>
              </span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">{counts[s]}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
