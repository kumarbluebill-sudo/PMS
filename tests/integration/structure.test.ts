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
