import { describe, expect, it } from "vitest";
import { housekeepingCode, isOverdue, parseCodeLabels, roomReady, taskStep, type RoomFacts } from "./housekeeping";

const room = (o: Partial<RoomFacts> = {}): RoomFacts => ({ occupied: false, clean: "CLEAN", dnd: false, outOfOrder: false, outOfService: false, stayoverPending: false, ...o });

describe("housekeepingCode", () => {
  it("derives vacant codes from cleanliness", () => {
    expect(housekeepingCode(room({ clean: "DIRTY" }))).toBe("VD");
    expect(housekeepingCode(room({ clean: "CLEANING" }))).toBe("VD");
    expect(housekeepingCode(room({ clean: "CLEAN" }))).toBe("VC");
    expect(housekeepingCode(room({ clean: "INSPECTED" }))).toBe("VI");
  });
  it("derives occupied codes and stayover without calling an occupied room vacant", () => {
    expect(housekeepingCode(room({ occupied: true, clean: "DIRTY" }))).toBe("OD");
    expect(housekeepingCode(room({ occupied: true, clean: "CLEAN" }))).toBe("OC");
    expect(housekeepingCode(room({ occupied: true, clean: "DIRTY", stayoverPending: true }))).toBe("STAYOVER");
  });
  it("lets out of order beat out of service, which beats DND, which beats cleanliness", () => {
    expect(housekeepingCode(room({ outOfOrder: true, outOfService: true, dnd: true, occupied: true }))).toBe("OOO");
    expect(housekeepingCode(room({ outOfService: true, dnd: true }))).toBe("OOS");
    expect(housekeepingCode(room({ dnd: true, occupied: true, clean: "DIRTY" }))).toBe("DND");
  });
});

describe("roomReady", () => {
  it("never calls an occupied, out-of-order or out-of-service room ready", () => {
    for (const bad of [{ occupied: true }, { outOfOrder: true }, { outOfService: true }]) {
      expect(roomReady({ ...room({ clean: "INSPECTED" }), ...bad }, false)).toBe(false);
    }
  });
  it("needs inspection only when the hotel requires it", () => {
    expect(roomReady(room({ clean: "CLEAN" }), false)).toBe(true);
    expect(roomReady(room({ clean: "CLEAN" }), true)).toBe(false);
    expect(roomReady(room({ clean: "INSPECTED" }), true)).toBe(true);
    expect(roomReady(room({ clean: "DIRTY" }), false)).toBe(false);
    expect(roomReady(room({ clean: "CLEANING" }), false)).toBe(false);
  });
});

describe("taskStep", () => {
  const free = { inspectionRequired: false };
  const strict = { inspectionRequired: true };
  it("runs the plain cycle: start, complete", () => {
    expect(taskStep("PENDING", "START", free)).toEqual({ ok: true, status: "IN_PROGRESS", room: "CLEANING" });
    expect(taskStep("IN_PROGRESS", "COMPLETE", free)).toEqual({ ok: true, status: "DONE", room: "CLEAN" });
    expect(taskStep("PENDING", "COMPLETE", free)).toMatchObject({ ok: true, status: "DONE" });
  });
  it("with inspection required, completing leaves the room clean but awaiting inspection", () => {
    expect(taskStep("IN_PROGRESS", "COMPLETE", strict)).toEqual({ ok: true, status: "AWAITING_INSPECTION", room: "CLEAN" });
    expect(taskStep("AWAITING_INSPECTION", "INSPECT_PASS", strict)).toEqual({ ok: true, status: "INSPECTED", room: "INSPECTED", result: "PASSED" });
  });
  it("a failed inspection reopens the task and makes the room dirty again", () => {
    expect(taskStep("AWAITING_INSPECTION", "INSPECT_FAIL", strict)).toEqual({ ok: true, status: "PENDING", room: "DIRTY", result: "FAILED" });
  });
  it("only inspects rooms awaiting inspection, and only reopens finished tasks", () => {
    expect(taskStep("DONE", "INSPECT_PASS", free)).toMatchObject({ ok: false });
    expect(taskStep("PENDING", "INSPECT_FAIL", free)).toMatchObject({ ok: false });
    expect(taskStep("PENDING", "REOPEN", free)).toMatchObject({ ok: false });
    expect(taskStep("DONE", "REOPEN", free)).toEqual({ ok: true, status: "PENDING", room: "DIRTY" });
  });
  it("cannot restart, double-complete or request inspection too early", () => {
    expect(taskStep("IN_PROGRESS", "START", free)).toMatchObject({ ok: false });
    expect(taskStep("DONE", "COMPLETE", free)).toMatchObject({ ok: false });
    expect(taskStep("PENDING", "REQUEST_INSPECTION", free)).toMatchObject({ ok: false });
    expect(taskStep("DONE", "REQUEST_INSPECTION", free)).toMatchObject({ ok: true, status: "AWAITING_INSPECTION" });
  });
  it("cancels open tasks without touching the room", () => {
    expect(taskStep("PENDING", "CANCEL", free)).toEqual({ ok: true, status: "CANCELLED", room: null });
    expect(taskStep("DONE", "CANCEL", free)).toMatchObject({ ok: false });
  });
});

describe("labels and overdue", () => {
  it("lets a hotel rename codes and ignores nonsense lines", () => {
    const l = parseCodeLabels("VD=Dirty vacant\nXX=Nope\nbad line\nVC=");
    expect(l.VD).toBe("Dirty vacant");
    expect(l.VC).toBe("Vacant – Clean");
    expect((l as Record<string, string>).XX).toBeUndefined();
  });
  it("marks a task overdue only after the limit", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    expect(isOverdue(new Date("2026-10-20T10:30:00Z"), now, 120)).toBe(false);
    expect(isOverdue(new Date("2026-10-20T09:59:00Z"), now, 120)).toBe(true);
  });
});
