/**
 * Housekeeping rules, pure and free of the database.
 *
 * A room has several independent conditions: whether a guest is in it, how clean it is, whether it is Do Not
 * Disturb, and whether maintenance has taken it out of order or out of service. None of them is forced to stand in for
 * another. The familiar codes (VD, VC, VI, OD, OC, Stayover, DND, OOO, OOS) are only derived for display.
 */
export type CleanState = "DIRTY" | "CLEANING" | "CLEAN" | "INSPECTED";
export const CLEAN_STATES: readonly CleanState[] = ["DIRTY", "CLEANING", "CLEAN", "INSPECTED"];

export const HK_CODES = ["VD", "VC", "VI", "OD", "OC", "STAYOVER", "DND", "OOO", "OOS"] as const;
export type HkCode = (typeof HK_CODES)[number];

export const HK_DEFAULT_LABELS: Record<HkCode, string> = {
  VD: "Vacant – Dirty", VC: "Vacant – Clean", VI: "Inspected", OD: "Occupied – Dirty", OC: "Occupied – Clean",
  STAYOVER: "Pickup / Stayover", DND: "Do Not Disturb", OOO: "Out of Order", OOS: "Out of Service",
};
export const HK_SHORT: Record<HkCode, string> = { VD: "VD", VC: "VC", VI: "VI", OD: "OD", OC: "OC", STAYOVER: "SO", DND: "DND", OOO: "OOO", OOS: "OOS" };

/** A hotel may rename the statuses. Lines look like `VD=Vacant – Dirty`; unknown codes and blanks are ignored. */
export function parseCodeLabels(raw: string): Record<HkCode, string> {
  const out = { ...HK_DEFAULT_LABELS };
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z]+)\s*=\s*(.{1,40})\s*$/.exec(line);
    if (m && (HK_CODES as readonly string[]).includes(m[1])) out[m[1] as HkCode] = m[2].trim();
  }
  return out;
}

export type RoomFacts = {
  occupied: boolean;
  clean: CleanState;
  dnd: boolean;
  outOfOrder: boolean;
  outOfService: boolean;
  /** An open stayover (pickup) task for an occupied room. */
  stayoverPending: boolean;
};

/** The display code for a room. Out of order beats everything, then out of service, then Do Not Disturb. */
export function housekeepingCode(f: RoomFacts): HkCode {
  if (f.outOfOrder) return "OOO";
  if (f.outOfService) return "OOS";
  if (f.dnd) return "DND";
  if (f.occupied) {
    if (f.stayoverPending) return "STAYOVER";
    return f.clean === "CLEAN" || f.clean === "INSPECTED" ? "OC" : "OD";
  }
  if (f.clean === "INSPECTED") return "VI";
  return f.clean === "CLEAN" ? "VC" : "VD";
}

/**
 * Is the room fit to give to an arriving guest? Never when it is out of order, out of service or occupied. A clean
 * room counts only when the hotel does not require inspection; otherwise it must have been inspected.
 */
export function roomReady(f: Pick<RoomFacts, "occupied" | "clean" | "outOfOrder" | "outOfService">, inspectionRequired: boolean): boolean {
  if (f.outOfOrder || f.outOfService || f.occupied) return false;
  return f.clean === "INSPECTED" || (f.clean === "CLEAN" && !inspectionRequired);
}

export const TASK_STATUSES = ["PENDING", "IN_PROGRESS", "AWAITING_INSPECTION", "DONE", "INSPECTED", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["PENDING", "IN_PROGRESS", "AWAITING_INSPECTION"];
export const TASK_ACTIONS = ["START", "COMPLETE", "REQUEST_INSPECTION", "INSPECT_PASS", "INSPECT_FAIL", "REOPEN", "CANCEL"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export type TaskStep = { ok: true; status: TaskStatus; room: CleanState | null; result?: "PASSED" | "FAILED" } | { ok: false; reason: string };

const no = (reason: string): TaskStep => ({ ok: false, reason });

/**
 * What an action does to a task and to the room's cleanliness. `room: null` leaves the room as it is.
 * With inspection required, finishing cleaning leaves the room clean but awaiting inspection; it is not ready until
 * someone inspects it. A failed inspection sends the task back to the start and the room back to dirty.
 */
export function taskStep(status: TaskStatus, action: TaskAction, opts: { inspectionRequired: boolean }): TaskStep {
  switch (action) {
    case "START":
      return status === "PENDING" ? { ok: true, status: "IN_PROGRESS", room: "CLEANING" } : no("Only a task that has not started can be started.");
    case "COMPLETE":
      if (status !== "PENDING" && status !== "IN_PROGRESS") return no("This task is not open for cleaning.");
      return opts.inspectionRequired ? { ok: true, status: "AWAITING_INSPECTION", room: "CLEAN" } : { ok: true, status: "DONE", room: "CLEAN" };
    case "REQUEST_INSPECTION":
      return status === "DONE" || status === "IN_PROGRESS" ? { ok: true, status: "AWAITING_INSPECTION", room: "CLEAN" } : no("Inspection can be requested once cleaning is done.");
    case "INSPECT_PASS":
      return status === "AWAITING_INSPECTION" ? { ok: true, status: "INSPECTED", room: "INSPECTED", result: "PASSED" } : no("Only a room awaiting inspection can be inspected.");
    case "INSPECT_FAIL":
      return status === "AWAITING_INSPECTION" ? { ok: true, status: "PENDING", room: "DIRTY", result: "FAILED" } : no("Only a room awaiting inspection can be inspected.");
    case "REOPEN":
      return status === "DONE" || status === "INSPECTED" || status === "AWAITING_INSPECTION" ? { ok: true, status: "PENDING", room: "DIRTY" } : no("Only a finished task can be reopened.");
    case "CANCEL":
      return status === "PENDING" || status === "IN_PROGRESS" ? { ok: true, status: "CANCELLED", room: null } : no("Only an open task can be cancelled.");
  }
}

export const isOverdue = (createdAt: Date, now: Date, overdueMinutes: number) => now.getTime() - createdAt.getTime() > overdueMinutes * 60_000;

export const PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const priorityRank = (p: string) => (p === "URGENT" ? 0 : p === "HIGH" ? 1 : 2);
