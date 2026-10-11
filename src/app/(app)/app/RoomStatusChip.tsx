import { DISPLAY_STATUSES, STATUS_META, type DisplayStatus } from "@/server/domain/roomStatus";

/** Status is shown with an icon and a text label as well as colour. */
export function RoomStatusChip({ status }: { status: DisplayStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${m.chip}`} title={m.hint}>
      <span aria-hidden="true">{m.icon}</span>
      {m.label}
    </span>
  );
}

export function RoomStatusLegend() {
  return (
    <ul aria-label="Room status legend" className="flex flex-wrap gap-2">
      {DISPLAY_STATUSES.map((s) => (
        <li key={s} className="flex items-center gap-1 text-xs text-slate-600">
          <RoomStatusChip status={s} />
          <span className="hidden sm:inline">{STATUS_META[s].hint}</span>
        </li>
      ))}
    </ul>
  );
}
