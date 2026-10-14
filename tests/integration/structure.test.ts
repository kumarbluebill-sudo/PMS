import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { assignRoomFloor, createBuilding, createFloor, listStructure, reorder, setBuildingActive, setFloorActive } from "@/server/services/structure";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let owner: Ctx;
let other: Ctx;

async function tenant(label: string) {
  const r = await registerTenant(app, {
    businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner",
    email: `str-${label}-${sfx}@test.local`, password: "correct-horse-battery",
  });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}

beforeAll(async () => {
  app = createDb(APP_URL);
  owner = await tenant("a");
  other = await tenant("b");
});
afterAll(() => app.$disconnect());

describe("buildings and floors", () => {
  it("creates buildings and floors, rejecting duplicates", async () => {
    const b = await createBuilding(app, owner, { name: "Tower A" });
    await expect(createBuilding(app, owner, { name: "Tower A" })).rejects.toThrow(/already exists/);
    await createFloor(app, owner, { buildingId: b.id, label: "Floor 1", level: 1 });
    await expect(createFloor(app, owner, { buildingId: b.id, label: "Floor 1", level: 1 })).rejects.toThrow(/already has/);
    // same label allowed in another building
    const b2 = await createBuilding(app, owner, { name: "Tower B" });
    await createFloor(app, owner, { buildingId: b2.id, label: "Floor 1", level: 1 });
    const s = await listStructure(app, owner);
    expect(s.map((x) => x.name)).toEqual(["Tower A", "Tower B"]);
  });

  it("assigns rooms to floors and keeps the legacy floor number in sync", async () => {
    const b = await createBuilding(app, owner, { name: "Wing C" });
    const f = await createFloor(app, owner, { buildingId: b.id, label: "Third", level: 3 });
    const rt = await createRoomType(app, owner, { name: "Std", amenities: ["AC", "WiFi"], bedConfig: "1 King" });
    const room = await createRoom(app, owner, { roomTypeId: rt.id, number: "301", floorId: f.id });
    expect(room.floor).toBe(3);
    expect(room.buildingId).toBe(b.id);
    expect(rt.amenities).toEqual(["AC", "WiFi"]);
    await expect(createRoom(app, owner, { roomTypeId: rt.id, number: "301" })).rejects.toThrow(/already exists/);
    await assignRoomFloor(app, owner, room.id, null);
    const s = await listStructure(app, owner);
    expect(s.find((x) => x.id === b.id)!.floors[0]._count.rooms).toBe(0);
  });

  it("deactivates instead of deleting and blocks assigning to inactive floors", async () => {
    const b = await createBuilding(app, owner, { name: "Old Wing" });
    const f = await createFloor(app, owner, { buildingId: b.id, label: "G", level: 0 });
    const rt = await createRoomType(app, owner, { name: "Old" });
    await setFloorActive(app, owner, f.id, false);
    await expect(createRoom(app, owner, { roomTypeId: rt.id, number: "001", floorId: f.id })).rejects.toThrow(/inactive/);
    await setBuildingActive(app, owner, b.id, false);
    const s = await listStructure(app, owner);
    expect(s.find((x) => x.id === b.id)!.active).toBe(false);
  });

  it("reorders buildings", async () => {
    const before = await listStructure(app, owner);
    const last = before[before.length - 1];
    await reorder(app, owner, { kind: "building", id: last.id, direction: "up" });
    const after = await listStructure(app, owner);
    expect(after[after.length - 2].id).toBe(last.id);
  });

  it("is tenant-isolated and permission-checked", async () => {
    expect((await listStructure(app, other)).length).toBe(0);
    const [b] = await listStructure(app, owner);
    await expect(createFloor(app, other, { buildingId: b.id, label: "X", level: 1 })).rejects.toThrow(/not found/i);
    const housekeeper: Ctx = { ...owner, role: "HOUSEKEEPING", extra: [], userId: randomUUID() };
    await expect(createBuilding(app, housekeeper, { name: "Nope" })).rejects.toThrow();
  });
});

describe("floor plan and import", () => {
  it("places rooms one per cell and rejects out-of-grid coordinates", async () => {
    const { placeRoom, getFloorPlan } = await import("@/server/services/structure");
    const b = await createBuilding(app, owner, { name: "Plan Block" });
    const f = await createFloor(app, owner, { buildingId: b.id, label: "P1", level: 1 });
    const rt = await createRoomType(app, owner, { name: "PlanType" });
    const r1 = await createRoom(app, owner, { roomTypeId: rt.id, number: "P101", floorId: f.id });
    const r2 = await createRoom(app, owner, { roomTypeId: rt.id, number: "P102", floorId: f.id });
    await placeRoom(app, owner, { roomId: r1.id, x: 0, y: 0 });
    await expect(placeRoom(app, owner, { roomId: r2.id, x: 0, y: 0 })).rejects.toThrow(/already in that cell/);
    await expect(placeRoom(app, owner, { roomId: r2.id, x: 99, y: 0 })).rejects.toThrow();
    await placeRoom(app, owner, { roomId: r2.id, x: 1, y: 0 });
    await placeRoom(app, owner, { roomId: r1.id, x: null, y: null });
    const plan = await getFloorPlan(app, owner, f.id);
    expect(plan.rooms.find((r) => r.id === r1.id)!.layoutX).toBeNull();
    // a room without a floor cannot be placed
    const loose = await createRoom(app, owner, { roomTypeId: rt.id, number: "P900" });
    await expect(placeRoom(app, owner, { roomId: loose.id, x: 2, y: 2 })).rejects.toThrow(/floor first/);
  });

  it("imports all-or-nothing with row-level errors", async () => {
    const { commitImport, previewImport } = await import("@/server/services/roomImport");
    const b = await createBuilding(app, owner, { name: "Import Block" });
    await createFloor(app, owner, { buildingId: b.id, label: "I1", level: 1 });
    await createRoomType(app, owner, { name: "ImpType" });
    const head = ["room_number", "category", "building", "floor"];
    const bad = [head, ["I101", "ImpType", "Import Block", "I1"], ["I102", "Nope", "Import Block", "I1"]];
    const p = await previewImport(app, owner, bad);
    expect(p.errors).toEqual([{ line: 3, message: 'Unknown category "Nope".' }]);
    await expect(commitImport(app, owner, bad)).rejects.toThrow(/Fix 1 error/);
    expect((await app.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`; return tx.room.count({ where: { number: "I101" } }); }))).toBe(0);
    const good = [head, ["I101", "ImpType", "Import Block", "I1"], ["I102", "imptype", "", ""]];
    expect((await commitImport(app, owner, good)).created).toBe(2);
    await expect(commitImport(app, owner, good)).rejects.toThrow();
  });
});

describe("onboarding wizard", () => {
  it("saves progress, resumes, and only completes with categories and rooms", async () => {
    const { getOnboarding, saveStep, completeOnboarding } = await import("@/server/services/onboarding");
    const fresh = await tenant("wiz");
    expect((await getOnboarding(app, fresh)).state.step).toBe(0);
    await saveStep(app, fresh, 3);
    expect((await getOnboarding(app, fresh)).state.step).toBe(3);
    await expect(saveStep(app, fresh, 9)).rejects.toThrow();
    await expect(completeOnboarding(app, fresh)).rejects.toThrow(/room category/);
    const rt = await createRoomType(app, fresh, { name: "W" });
    await expect(completeOnboarding(app, fresh)).rejects.toThrow(/at least one room/);
    await createRoom(app, fresh, { roomTypeId: rt.id, number: "1" });
    await completeOnboarding(app, fresh);
    expect((await getOnboarding(app, fresh)).state.completedAt).not.toBeNull();
    // another tenant has its own state
    expect((await getOnboarding(app, other)).state.completedAt).toBeNull();
  });
});

describe("row level security on new tables", () => {
  it("hides one tenant's rows from another at the database level", async () => {
    const { withTenant } = await import("@/server/db/withTenant");
    const tables = ["buildings", "floors", "onboarding_states", "message_templates", "guest_consents", "message_logs"];
    for (const t of tables) {
      const mine = await withTenant(app, owner.tenantId, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${t}`));
      const theirs = await withTenant(app, other.tenantId, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${t} WHERE "tenantId" = '${owner.tenantId}'`));
      expect(Number(theirs[0].n), t).toBe(0);
      if (t === "buildings") expect(Number(mine[0].n)).toBeGreaterThan(0);
    }
    // writing a row for another tenant is rejected by the policy
    await expect(withTenant(app, other.tenantId, (tx) => tx.building.create({ data: { tenantId: owner.tenantId, propertyId: owner.propertyId!, name: "Sneaky" } }))).rejects.toThrow();
  });
});
