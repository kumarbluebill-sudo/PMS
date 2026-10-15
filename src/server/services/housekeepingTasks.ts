import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { blockCoversDate } from "@/server/domain/roomBlock";
import { dateInZone } from "@/server/domain/roomStatus";
import {
  housekeepingCode, isOverdue, OPEN_TASK_STATUSES, parseCodeLabels, priorityRank, PRIORITIES, roomReady, taskStep,
  type CleanState, type HkCode, type TaskAction, type TaskStatus,
} from "@/server/domain/housekeeping";
import { audit } from "./audit";
import { notifyTx } from "./notifications";
import { loadSettings } from "./settings";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export type BoardFilter = {
  q?: string; floorId?: string; roomTypeId?: string; code?: HkCode; assignee?: "me" | "none" | string; priority?: string;
  state?: "awaiting-cleaning" | "cleaning" | "awaiting-inspection" | "ready" | "arrivals-not-ready" | "overdue" | "ooo" | "dnd" | "departed";
};

export type BoardRow = {
  roomId: string; number: string; name: string | null; floor: string | null; category: string; code: HkCode; clean: CleanState; dnd: boolean; ready: boolean;
  occupied: boolean;
  /** Visible only to staff who may see reservations (reference) and guests (name). */
  reservationRef: string | null; reservationId: string | null; guest: string | null;
  checkout: "In house" | "Departing today" | "Departed today" | "Vacant";
  arrivalToday: boolean;
  task: null | { id: string; kind: string; status: TaskStatus; priority: string; assignedToId: string | null; assignedTo: string | null; createdAt: Date; updatedAt: Date; version: number; note: string | null; inspectionResult: string | null };
  lastUpdate: Date | null;
  overdue: boolean;
  maintenance: { open: number; blocking: boolean; title: string | null };
};

/**
 * The housekeeping board: every active room with its derived status code, its open cleaning task, who is assigned,
 * and what the front desk needs to know (departure, arrival today, readiness). Guest details are included only for
 * staff who may see them, so a housekeeper sees rooms and tasks but not guest records.
 */
export async function housekeepingBoard(db: PrismaClient, ctx: Ctx, f: BoardFilter = {}) {
  authorize(ctx, "housekeeping.view");
  const propertyId = requireProperty(ctx);
  const canRef = roleHasPermission(ctx.role, "reservations.view", ctx.extra);
  const canGuest = canRef && roleHasPermission(ctx.role, "guests.view", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [st, property] = await Promise.all([loadSettings(tx, ctx.tenantId, propertyId), tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } })]);
    const now = new Date();
    const today = dateInZone(now, property.timezone);
    const labels = parseCodeLabels(st["housekeeping.codeLabels"]);
    const rooms = await tx.room.findMany({
      where: { propertyId, active: true, ...(f.floorId && { floorId: f.floorId }), ...(f.roomTypeId && { roomTypeId: f.roomTypeId }), ...(f.q?.trim() && { number: { contains: f.q.trim(), mode: "insensitive" } }) },
      include: { roomType: { select: { name: true } }, floorRef: { select: { label: true } } },
      orderBy: { number: "asc" },
    });
    const ids = rooms.map((r) => r.id);
    const [tasks, stays, arrivals, departed, maint] = await Promise.all([
      tx.housekeepingTask.findMany({ where: { propertyId, roomId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 1500 }),
      tx.roomAssignment.findMany({ where: { propertyId, roomId: { in: ids }, active: true, reservation: { status: "CHECKED_IN" } }, include: { reservation: { include: { guest: { select: { name: true } } } } } }),
      tx.roomAssignment.findMany({ where: { propertyId, roomId: { in: ids }, active: true, arrival: toDate(today), reservation: { status: { in: ["CONFIRMED", "TENTATIVE"] } } }, select: { roomId: true } }),
      tx.reservation.findMany({ where: { propertyId, status: "CHECKED_OUT", actualDeparture: { gte: new Date(now.getTime() - 40 * 3_600_000) } }, select: { id: true, reference: true, actualDeparture: true, guest: { select: { name: true } }, assignments: { select: { roomId: true }, orderBy: { createdAt: "desc" }, take: 1 } } }),
      tx.maintenanceRequest.findMany({ where: { propertyId, roomId: { in: ids }, status: { not: "RESOLVED" } }, select: { roomId: true, title: true, blocksRoom: true, mode: true, startDate: true, expectedResolution: true } }),
    ]);
    const userIds = [...new Set(tasks.map((t) => t.assignedTo).filter((x): x is string => !!x))];
    const users = userIds.length ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const uname = new Map(users.map((u) => [u.id, u.name]));

    const open = new Map<string, (typeof tasks)[number]>();
    const latest = new Map<string, (typeof tasks)[number]>();
    for (const t of tasks) {
      if (!latest.has(t.roomId)) latest.set(t.roomId, t);
      if (OPEN_TASK_STATUSES.includes(t.status as TaskStatus) && !open.has(t.roomId)) open.set(t.roomId, t);
    }
    const stayBy = new Map(stays.map((a) => [a.roomId, a.reservation]));
    const arrivingRooms = new Set(arrivals.map((a) => a.roomId));
    const departedBy = new Map<string, (typeof departed)[number]>();
    for (const d of departed) {
      const rid = d.assignments[0]?.roomId;
      if (rid && d.actualDeparture && dateInZone(d.actualDeparture, property.timezone) === today && !departedBy.has(rid)) departedBy.set(rid, d);
    }

    let rows: BoardRow[] = rooms.map((r) => {
      const stay = stayBy.get(r.id) ?? null;
      const m = maint.filter((x) => x.roomId === r.id);
      const live = m.filter((x) => x.blocksRoom && blockCoversDate({ startDate: x.startDate ? iso(x.startDate) : null, expectedResolution: x.expectedResolution ? iso(x.expectedResolution) : null }, today));
      const oos = live.some((x) => x.mode === "MAINTENANCE_BLOCK");
      const ooo = r.outOfOrder || live.some((x) => x.mode === "OUT_OF_ORDER");
      const t = open.get(r.id) ?? null;
      const occupied = !!stay;
      const clean = r.housekeeping as CleanState;
      const code = housekeepingCode({ occupied, clean, dnd: r.dnd, outOfOrder: ooo, outOfService: oos, stayoverPending: occupied && t?.kind === "STAYOVER" });
      const ready = roomReady({ occupied, clean, outOfOrder: ooo, outOfService: oos }, st["housekeeping.inspectionRequired"]);
      const dep = departedBy.get(r.id);
      return {
        roomId: r.id, number: r.number, name: r.name, floor: r.floorRef?.label ?? null, category: r.roomType.name, code, clean, dnd: r.dnd, ready, occupied,
        reservationRef: canRef ? (stay?.reference ?? dep?.reference ?? null) : null, reservationId: canRef ? (stay?.id ?? dep?.id ?? null) : null,
        guest: canGuest ? (stay?.guest.name ?? dep?.guest.name ?? null) : null,
        checkout: stay ? (iso(stay.departure) === today ? "Departing today" : "In house") : dep ? "Departed today" : "Vacant",
        arrivalToday: arrivingRooms.has(r.id),
        task: t ? { id: t.id, kind: t.kind, status: t.status as TaskStatus, priority: t.priority, assignedToId: t.assignedTo, assignedTo: t.assignedTo ? (uname.get(t.assignedTo) ?? "Staff") : null, createdAt: t.createdAt, updatedAt: t.updatedAt, version: t.version, note: t.note, inspectionResult: t.inspectionResult } : null,
        lastUpdate: latest.get(r.id)?.updatedAt ?? null,
        overdue: !!t && isOverdue(t.createdAt, now, st["housekeeping.overdueMinutes"]),
        maintenance: { open: m.length, blocking: live.length > 0, title: (live[0] ?? m[0])?.title ?? null },
      };
    });

    const summary = {
      awaitingCleaning: rows.filter((r) => !r.occupied && r.clean === "DIRTY" && r.code !== "OOO" && r.code !== "OOS").length,
      beingCleaned: rows.filter((r) => r.clean === "CLEANING").length,
      awaitingInspection: rows.filter((r) => r.task?.status === "AWAITING_INSPECTION").length,
      ready: rows.filter((r) => r.ready).length,
      arrivalsNotReady: rows.filter((r) => r.arrivalToday && !r.ready).length,
      outOfOrder: rows.filter((r) => r.code === "OOO").length,
      overdue: rows.filter((r) => r.overdue).length,
      dnd: rows.filter((r) => r.dnd).length,
      departedToday: rows.filter((r) => r.checkout === "Departed today").length,
      total: rows.length,
    };

    if (f.code) rows = rows.filter((r) => r.code === f.code);
    if (f.priority) rows = rows.filter((r) => r.task?.priority === f.priority);
    if (f.assignee === "me") rows = rows.filter((r) => r.task?.assignedToId === ctx.userId);
    else if (f.assignee === "none") rows = rows.filter((r) => r.task && !r.task.assignedToId);
    else if (f.assignee) rows = rows.filter((r) => r.task?.assignedToId === f.assignee);
    switch (f.state) {
      case "awaiting-cleaning": rows = rows.filter((r) => !r.occupied && r.clean === "DIRTY" && r.code !== "OOO" && r.code !== "OOS"); break;
      case "cleaning": rows = rows.filter((r) => r.clean === "CLEANING"); break;
      case "awaiting-inspection": rows = rows.filter((r) => r.task?.status === "AWAITING_INSPECTION"); break;
      case "ready": rows = rows.filter((r) => r.ready); break;
      case "arrivals-not-ready": rows = rows.filter((r) => r.arrivalToday && !r.ready); break;
      case "overdue": rows = rows.filter((r) => r.overdue); break;
      case "ooo": rows = rows.filter((r) => r.code === "OOO"); break;
      case "dnd": rows = rows.filter((r) => r.dnd); break;
      case "departed": rows = rows.filter((r) => r.checkout === "Departed today"); break;
    }
    rows.sort((a, b) =>
      Number(b.arrivalToday && !b.ready) - Number(a.arrivalToday && !a.ready) || Number(b.overdue) - Number(a.overdue) ||
      priorityRank(a.task?.priority ?? "NORMAL") - priorityRank(b.task?.priority ?? "NORMAL") || a.number.localeCompare(b.number, undefined, { numeric: true }));
    return { rows, summary, labels, inspectionRequired: st["housekeeping.inspectionRequired"], today };
  });
}

/** Housekeeping staff of this property, for assigning tasks. */
export async function housekeepingStaff(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "housekeeping.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const ms = await tx.membership.findMany({
      where: { tenantId: ctx.tenantId, active: true, role: "HOUSEKEEPING", properties: { some: { propertyId } } },
      include: { user: { select: { id: true, name: true, active: true } } },
    });
    return ms.filter((m) => m.user.active).map((m) => ({ id: m.user.id, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name));
  });
}

export const TASK_INPUT_ACTIONS = ["START", "COMPLETE", "REQUEST_INSPECTION", "INSPECT_PASS", "INSPECT_FAIL", "REOPEN", "CANCEL", "ASSIGN", "NOTE", "PRIORITY"] as const;
const actionSchema = z.object({
  taskId: z.string().uuid(),
  action: z.enum(TASK_INPUT_ACTIONS),
  expectedVersion: z.number().int().min(0),
  assignedTo: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(300).optional(),
  priority: z.enum(PRIORITIES).optional(),
});
export type TaskActionInput = z.input<typeof actionSchema>;

const MANAGER_ACTIONS = new Set(["INSPECT_PASS", "INSPECT_FAIL", "REOPEN", "CANCEL", "ASSIGN", "PRIORITY"]);

/** Appends a dated line to a task's notes, keeping the most recent 1000 characters. */
const appendNote = (cur: string | null, who: string, text: string, at: Date) => `${cur ? `${cur}\n` : ""}${at.toISOString().slice(0, 16).replace("T", " ")} ${who}: ${text}`.slice(-1000);

/**
 * One entry point for every change to a cleaning task. The task must still be at the version the staff member loaded;
 * if someone else changed it first, nothing is overwritten and the message says so. The room's cleanliness follows the
 * task through the shared rules, and every change is recorded with who made it.
 */
export async function taskAction(db: PrismaClient, ctx: Ctx, input: unknown) {
  const d = actionSchema.parse(input);
  authorize(ctx, MANAGER_ACTIONS.has(d.action) ? "housekeeping.manage" : "housekeeping.update");
  const propertyId = requireProperty(ctx);
  const isManager = roleHasPermission(ctx.role, "housekeeping.manage", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM housekeeping_tasks WHERE id = ${d.taskId}::uuid AND "propertyId" = ${propertyId}::uuid FOR UPDATE`;
    if (!locked.length) throw new AppError("NOT_FOUND", "Task not found.");
    const t = await tx.housekeepingTask.findUniqueOrThrow({ where: { id: d.taskId }, include: { room: true } });
    if (t.version !== d.expectedVersion) {
      const by = t.updatedBy ? (await tx.user.findUnique({ where: { id: t.updatedBy }, select: { name: true } }))?.name : null;
      throw new AppError("CONFLICT", `${by ? `${by} just updated` : "Someone just updated"} this task (now ${t.status.replace(/_/g, " ").toLowerCase()}). Reload the page and check before acting.`);
    }
    if (!isManager && t.assignedTo && t.assignedTo !== ctx.userId && ["START", "COMPLETE", "REQUEST_INSPECTION"].includes(d.action)) {
      const who = (await tx.user.findUnique({ where: { id: t.assignedTo }, select: { name: true } }))?.name ?? "another staff member";
      throw new AppError("CONFLICT", `This task is assigned to ${who}. Ask a supervisor to reassign it.`);
    }
    const st = await loadSettings(tx, ctx.tenantId, propertyId);
    const now = new Date();
    const data: Prisma.HousekeepingTaskUncheckedUpdateInput = { version: { increment: 1 }, updatedBy: ctx.userId, updatedAt: now };
    const me = (await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? "Staff";
    let roomChange: { from: CleanState; to: CleanState } | null = null;
    let status: TaskStatus = t.status as TaskStatus;

    if (d.action === "ASSIGN") {
      if (d.assignedTo) {
        const staff = await tx.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: d.assignedTo, active: true, properties: { some: { propertyId } } } });
        if (!staff) throw new AppError("VALIDATION", "That person does not work at this property.");
      }
      data.assignedTo = d.assignedTo ?? null;
    } else if (d.action === "NOTE") {
      if (!d.note) throw new AppError("VALIDATION", "Write the note first.");
      data.note = appendNote(t.note, me, d.note, now);
    } else if (d.action === "PRIORITY") {
      if (!d.priority) throw new AppError("VALIDATION", "Choose a priority.");
      data.priority = d.priority;
    } else {
      const step = taskStep(t.status as TaskStatus, d.action as TaskAction, { inspectionRequired: st["housekeeping.inspectionRequired"] });
      if (!step.ok) throw new AppError("CONFLICT", step.reason);
      status = step.status;
      data.status = step.status;
      if (d.action === "START") { data.startedAt = now; if (!t.assignedTo) data.assignedTo = ctx.userId; }
      if (step.status === "DONE" || step.status === "INSPECTED") data.doneAt = now;
      if (step.status === "AWAITING_INSPECTION") data.inspectionRequestedAt = now;
      if (step.result) { data.inspectionResult = step.result; data.inspectedBy = ctx.userId; data.inspectedAt = now; }
      if (d.action === "REOPEN" || d.action === "INSPECT_FAIL") { data.doneAt = null; data.startedAt = null; }
      if (d.note) data.note = appendNote(t.note, me, d.note, now);
      if (step.room && step.room !== (t.room.housekeeping as CleanState)) roomChange = { from: t.room.housekeeping as CleanState, to: step.room };
    }

    await tx.housekeepingTask.update({ where: { id: t.id }, data });
    if (roomChange) {
      await tx.room.update({ where: { id: t.roomId }, data: { housekeeping: roomChange.to } });
      await tx.roomStatusHistory.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: t.roomId, kind: "HOUSEKEEPING", fromState: roomChange.from, toState: roomChange.to, reason: `Task ${d.action.toLowerCase().replace(/_/g, " ")}`, changedBy: ctx.userId } });
    }
    await audit(tx, ctx, {
      action: `housekeeping.task_${d.action.toLowerCase()}`, entityType: "HousekeepingTask", entityId: t.id,
      before: { status: t.status, room: t.room.number, assignedTo: t.assignedTo ?? null }, after: { status, room: t.room.number, assignedTo: (data.assignedTo as string | null | undefined) ?? t.assignedTo ?? null, version: t.version + 1 },
      reason: d.note || undefined,
    });

    // Tell the right people, once per change.
    const key = (e: string) => `hk:${e}:${t.id}:${t.version + 1}`;
    if (status === "AWAITING_INSPECTION" && t.status !== "AWAITING_INSPECTION") {
      await notifyTx(tx, ctx, { dedupeKey: key("inspect"), kind: "INSPECTION_REQUESTED", title: `Room ${t.room.number} is awaiting inspection`, href: "/app/housekeeping?state=awaiting-inspection", audiencePerm: "housekeeping.manage" });
    }
    if (d.action === "INSPECT_FAIL") {
      await notifyTx(tx, ctx, { dedupeKey: key("failed"), kind: "INSPECTION_FAILED", title: `Room ${t.room.number} failed inspection`, body: d.note || "Needs cleaning again.", href: "/app/housekeeping", audiencePerm: "housekeeping.update" });
    }
    if (roomChange && (roomChange.to === "INSPECTED" || (roomChange.to === "CLEAN" && !st["housekeeping.inspectionRequired"]))) {
      const arriving = await tx.roomAssignment.count({ where: { roomId: t.roomId, active: true, reservation: { status: { in: ["CONFIRMED", "TENTATIVE"] } }, arrival: toDate(dateInZone(now, (await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } })).timezone)) } });
      const occupied = await tx.roomAssignment.count({ where: { roomId: t.roomId, active: true, reservation: { status: "CHECKED_IN" } } });
      if (arriving > 0 && !occupied) {
        await notifyTx(tx, ctx, { dedupeKey: key("ready"), kind: "ROOM_READY", title: `Room ${t.room.number} is ready for today's arrival`, href: "/app/operations", audiencePerm: "frontdesk.checkin" });
      }
    }
    return { id: t.id, status, version: t.version + 1 };
  });
}

/** Do Not Disturb is recorded on the room, with who set it, and cleared the same way. Checkout clears it. */
export async function setDnd(db: PrismaClient, ctx: Ctx, roomId: string, dnd: boolean, note?: string) {
  authorize(ctx, "housekeeping.update");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: roomId, propertyId, active: true } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    if (room.dnd === dnd) return room;
    const r = await tx.room.update({ where: { id: roomId }, data: { dnd, dndAt: dnd ? new Date() : null } });
    await tx.roomStatusHistory.create({ data: { tenantId: ctx.tenantId, propertyId, roomId, kind: "HOUSEKEEPING", fromState: room.dnd ? "DND" : "OPEN", toState: dnd ? "DND" : "OPEN", reason: note?.trim() || (dnd ? "Do Not Disturb" : "Do Not Disturb cleared"), changedBy: ctx.userId } });
    await audit(tx, ctx, { action: dnd ? "room.dnd_on" : "room.dnd_off", entityType: "Room", entityId: roomId, after: { room: room.number, dnd }, reason: note?.trim() || undefined });
    return r;
  });
}

const createSchema = z.object({ roomId: z.string().uuid(), kind: z.enum(["PRIORITY", "STAYOVER", "DEPARTURE"]).default("PRIORITY"), priority: z.enum(PRIORITIES).default("NORMAL"), note: z.string().trim().max(300).optional(), assignedTo: z.string().uuid().optional() });

/** A supervisor opens a cleaning task by hand (a rush clean, a deep clean). One open task per room at a time. */
export async function createTask(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "housekeeping.manage");
  const propertyId = requireProperty(ctx);
  const d = createSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: d.roomId, propertyId, active: true } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    const existing = await tx.housekeepingTask.findFirst({ where: { roomId: room.id, status: { in: [...OPEN_TASK_STATUSES] } } });
    if (existing) throw new AppError("CONFLICT", `Room ${room.number} already has an open cleaning task.`);
    const t = await tx.housekeepingTask.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: room.id, kind: d.kind, priority: d.priority, note: d.note, assignedTo: d.assignedTo, updatedBy: ctx.userId } });
    if (room.housekeeping !== "DIRTY") {
      await tx.room.update({ where: { id: room.id }, data: { housekeeping: "DIRTY" } });
      await tx.roomStatusHistory.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: room.id, kind: "HOUSEKEEPING", fromState: room.housekeeping, toState: "DIRTY", reason: "Cleaning task created", changedBy: ctx.userId } });
    }
    await audit(tx, ctx, { action: "housekeeping.task_create", entityType: "HousekeepingTask", entityId: t.id, after: { room: room.number, kind: d.kind, priority: d.priority } });
    return t;
  });
}

/**
 * Opens today's stayover (pickup) task for every in-house room that does not already have one and is not Do Not
 * Disturb. Safe to run more than once a day. Stayover rooms are occupied and need service, so they show Occupied – Dirty.
 */
export async function generateStayoverTasks(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "housekeeping.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const property = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
    const today = dateInZone(new Date(), property.timezone);
    const stays = await tx.roomAssignment.findMany({
      where: { propertyId, active: true, reservation: { status: "CHECKED_IN" }, departure: { gt: toDate(today) }, arrival: { lte: toDate(today) } },
      include: { room: true },
    });
    let created = 0, skippedDnd = 0, existing = 0;
    for (const a of stays) {
      if (a.room.dnd) { skippedDnd++; continue; }
      const open = await tx.housekeepingTask.findFirst({ where: { roomId: a.roomId, status: { in: [...OPEN_TASK_STATUSES] } } });
      const todays = await tx.housekeepingTask.findMany({ where: { roomId: a.roomId, kind: "STAYOVER" }, orderBy: { createdAt: "desc" }, take: 1 });
      if (open || (todays[0] && dateInZone(todays[0].createdAt, property.timezone) === today)) { existing++; continue; }
      await tx.housekeepingTask.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: a.roomId, kind: "STAYOVER", updatedBy: ctx.userId } });
      if (a.room.housekeeping !== "DIRTY") await tx.room.update({ where: { id: a.roomId }, data: { housekeeping: "DIRTY" } });
      created++;
    }
    await audit(tx, ctx, { action: "housekeeping.stayover_generated", entityType: "Property", entityId: propertyId, after: { created, skippedDnd, existing, date: today } });
    return { created, skippedDnd, existing };
  });
}

export const reportSchema = z.object({ roomId: z.string().uuid(), category: z.string(), title: z.string().trim().min(3, "Say what is wrong.").max(200), description: z.string().trim().max(2000).optional(), priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL") });
