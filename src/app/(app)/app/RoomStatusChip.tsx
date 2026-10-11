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
