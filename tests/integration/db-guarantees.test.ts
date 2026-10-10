import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { ADMIN_URL } from "./global-setup";
import type { PrismaClient } from "@prisma/client";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
let admin: PrismaClient;
let app: PrismaClient;
let A: { tenant: string; property: string; room: string; guest: string; roomType: string };
let B: { tenant: string };

async function seedTenant(name: string) {
  const tenant = await admin.tenant.create({ data: { legalName: name, displayName: name } });
  const property = await admin.property.create({ data: { tenantId: tenant.id, name: `${name} Hotel` } });
  const roomType = await admin.roomType.create({
    data: { tenantId: tenant.id, propertyId: property.id, name: "Deluxe" },
  });
  const room = await admin.room.create({
    data: { tenantId: tenant.id, propertyId: property.id, roomTypeId: roomType.id, number: "101" },
  });
  const guest = await admin.guest.create({ data: { tenantId: tenant.id, name: "Test Guest" } });
  return { tenant: tenant.id, property: property.id, room: room.id, guest: guest.id, roomType: roomType.id };
}

async function book(arrival: string, departure: string, suffix: string) {
  return admin.$transaction(async (tx) => {
    const r = await tx.reservation.create({
      data: {
        tenantId: A.tenant, propertyId: A.property, reference: `R-${suffix}`, guestId: A.guest,
        roomTypeId: A.roomType, arrival: new Date(arrival), departure: new Date(departure),
        createdBy: A.guest,
      },
    });
    return tx.roomAssignment.create({
      data: {
        tenantId: A.tenant, propertyId: A.property, roomId: A.room, reservationId: r.id,
        arrival: new Date(arrival), departure: new Date(departure),
      },
    });
  });
}

beforeAll(async () => {
  admin = createDb(ADMIN_URL);
  app = createDb(APP_URL);
  const suffix = Date.now().toString(36);
  A = await seedTenant(`A-${suffix}`);
  B = await seedTenant(`B-${suffix}`);
});
afterAll(async () => {
  await admin.$disconnect();
  await app.$disconnect();
});

describe("double-booking prevention", () => {
  it("rejects an overlapping assignment, allows back-to-back", async () => {
    await book("2030-01-01", "2030-01-04", "1");
    await expect(book("2030-01-03", "2030-01-05", "2")).rejects.toThrow();
    await expect(book("2030-01-04", "2030-01-06", "3")).resolves.toBeTruthy();
  });

  it("lets exactly one of many concurrent bookings win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => book("2030-06-01", "2030-06-03", `c${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("audit log immutability", () => {
  it("blocks update and delete", async () => {
    const row = await admin.auditLog.create({
      data: { tenantId: A.tenant, action: "test", entityType: "Test" },
    });
    await expect(admin.auditLog.update({ where: { id: row.id }, data: { action: "x" } })).rejects.toThrow();
    await expect(admin.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
  });
});

describe("tenant isolation (RLS)", () => {
  it("shows a tenant only its own guests", async () => {
    const seenByA = await withTenant(app, A.tenant, (tx) => tx.guest.findMany());
    expect(seenByA.every((g) => g.tenantId === A.tenant)).toBe(true);
    expect(seenByA.length).toBeGreaterThan(0);
    const aSeesB = await withTenant(app, A.tenant, (tx) =>
      tx.reservation.findMany({ where: { tenantId: B.tenant } }),
    );
    expect(aSeesB).toHaveLength(0);
  });

  it("returns nothing without a tenant context", async () => {
    expect(await app.guest.findMany()).toHaveLength(0);
  });

  it("blocks writing rows for another tenant", async () => {
    await expect(
      withTenant(app, A.tenant, (tx) => tx.guest.create({ data: { tenantId: B.tenant, name: "x" } })),
    ).rejects.toThrow();
  });
});
