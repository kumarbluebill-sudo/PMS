import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant, verifyCredentials } from "@/server/services/tenant";
import {
  acceptInvite, beginMfaEnrolment, checkTotp, confirmMfaEnrolment, currentTotp, inviteMember,
  requestPasswordReset, resetMemberMfa, resetPassword, sendVerification, verifyEmail,
} from "@/server/services/accounts";
import { listMembers, updateMember } from "@/server/services/users";
import { calendar, changeDeparture, listMaintenance, moveRoom, resolveMaintenance } from "@/server/services/stays";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { createReservation, checkIn, findFreeRooms } from "@/server/services/reservations";
import { createMaintenanceRequest, setRoomStatus } from "@/server/services/housekeeping";
import { withTenant } from "@/server/db/withTenant";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let owner: Ctx;
let tokenFrom: (to: string) => Promise<string>;

beforeAll(async () => {
  app = createDb(APP_URL);
  const r = await registerTenant(app, {
    businessName: "Acc Co", propertyName: "Acc Inn", name: "Owner",
    email: `acc-owner-${sfx}@test.local`, password: "correct-horse-battery",
  });
  owner = await loadContext(app, { userId: r.userId, epoch: 0 });
  tokenFrom = async (to) => {
    const m = await app.emailOutbox.findFirstOrThrow({ where: { toEmail: to }, orderBy: { createdAt: "desc" } });
    return /token=([\w-]+)/.exec(m.body)![1];
  };
});
afterAll(() => app.$disconnect());

describe("password reset", () => {
  const email = () => `acc-owner-${sfx}@test.local`;
  it("is silent for unknown emails and works once for real ones", async () => {
    await requestPasswordReset(app, "ghost@test.local");
    expect(await app.emailOutbox.count({ where: { toEmail: "ghost@test.local" } })).toBe(0);
    await requestPasswordReset(app, email());
    const t = await tokenFrom(email());
    await resetPassword(app, t, "brand-new-password-1");
    await expect(resetPassword(app, t, "another-password-22")).rejects.toThrow(/invalid or has expired/);
    expect(await verifyCredentials(app, email(), "brand-new-password-1")).toBeTruthy();
    expect(await verifyCredentials(app, email(), "correct-horse-battery")).toBeNull();
  });
  it("revokes existing sessions", async () => {
    await expect(loadContext(app, { userId: owner.userId, epoch: 0 })).rejects.toThrow();
    owner = await loadContext(app, { userId: owner.userId, epoch: 1 });
  });
  it("rejects expired tokens", async () => {
    await requestPasswordReset(app, email());
    const t = await tokenFrom(email());
    await app.authToken.updateMany({ where: { kind: "RESET", usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(resetPassword(app, t, "yet-another-password")).rejects.toThrow();
  });
});

describe("email verification", () => {
  it("verifies once", async () => {
    await sendVerification(app, owner.userId);
    const t = await tokenFrom(`acc-owner-${sfx}@test.local`);
    await verifyEmail(app, t);
    expect((await app.user.findUniqueOrThrow({ where: { id: owner.userId } })).emailVerifiedAt).toBeTruthy();
    await expect(verifyEmail(app, t)).rejects.toThrow();
  });
});

describe("MFA", () => {
  it("enrols with a valid TOTP, rejects wrong codes, and admin reset revokes", async () => {
    const { secret, uri } = await beginMfaEnrolment(app, owner);
    expect(uri).toContain("otpauth://totp/");
    expect(secret.length).toBeGreaterThan(10);
    await expect(confirmMfaEnrolment(app, owner, "000000")).rejects.toThrow();
    const u = await app.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(u.mfaSecretEnc).not.toContain(secret); // stored encrypted
    await confirmMfaEnrolment(app, owner, await currentTotp(u.mfaSecretEnc!));
    const after = await app.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(after.mfaEnabled).toBe(true);
    expect(await checkTotp(after.mfaSecretEnc!, "123456")).toBe(false);
    expect(await checkTotp(after.mfaSecretEnc!, await currentTotp(after.mfaSecretEnc!))).toBe(true);
  });
});

describe("invitations and member management", () => {
  let desk: Ctx;
  it("owner invites front desk staff, who accept once", async () => {
    await inviteMember(app, owner, { email: `desk-${sfx}@test.local`, role: "FRONT_DESK", propertyIds: [owner.propertyId!] });
    const t = await tokenFrom(`desk-${sfx}@test.local`);
    const { userId } = await acceptInvite(app, t, { name: "Desk Person", password: "desk-password-123" });
    await expect(acceptInvite(app, t, { name: "Again", password: "desk-password-123" })).rejects.toThrow();
    desk = await loadContext(app, { userId, epoch: 0 });
    expect(desk.role).toBe("FRONT_DESK");
    expect(desk.tenantId).toBe(owner.tenantId);
    expect(desk.propertyId).toBe(owner.propertyId);
  });
  it("front desk cannot manage users; managers cannot mint owners", async () => {
    await expect(inviteMember(app, desk, { email: "x@test.local", role: "FRONT_DESK", propertyIds: [] })).rejects.toThrow(/permission/i);
    const gm: Ctx = { ...owner, role: "GENERAL_MANAGER" };
    await expect(inviteMember(app, gm, { email: `o-${sfx}@test.local`, role: "HOTEL_OWNER", propertyIds: [] })).rejects.toThrow(/owner/i);
    await expect(inviteMember(app, owner, { email: `p-${sfx}@test.local`, role: "PLATFORM_SUPER_ADMIN", propertyIds: [] })).rejects.toThrow();
  });
  it("cannot invite to a property outside the caller's access", async () => {
    await expect(
      inviteMember(app, owner, { email: `q-${sfx}@test.local`, role: "FRONT_DESK", propertyIds: ["00000000-0000-4000-8000-000000000000"] }),
    ).rejects.toThrow();
  });
  it("deactivating a member revokes their session immediately; last owner is protected", async () => {
    const members = await listMembers(app, owner);
    const deskM = members.find((m) => m.userId === desk.userId)!;
    await updateMember(app, owner, deskM.id, { active: false });
    await expect(loadContext(app, { userId: desk.userId, epoch: 0 })).rejects.toThrow();
    const ownerM = members.find((m) => m.userId === owner.userId)!;
    await expect(updateMember(app, owner, ownerM.id, { active: false })).rejects.toThrow(/yourself/);
  });
  it("custom extra permissions require roles.manage and take effect", async () => {
    const members = await listMembers(app, owner);
    const deskM = members.find((m) => m.userId === desk.userId)!;
    await updateMember(app, owner, deskM.id, { active: true, extra: ["audit.view"] });
    const m = (await listMembers(app, owner)).find((x) => x.id === deskM.id)!;
    expect(m.extraPermissions).toContain("audit.view");
    const gm: Ctx = { ...owner, role: "PROPERTY_MANAGER" }; // lacks roles.manage
    await expect(updateMember(app, gm, deskM.id, { extra: ["finance.view"] })).rejects.toThrow(/permission/i);
  });
  it("admin MFA reset clears enrolment", async () => {
    await resetMemberMfa(app, owner, owner.userId);
    expect((await app.user.findUniqueOrThrow({ where: { id: owner.userId } })).mfaEnabled).toBe(false);
    owner = await loadContext(app, { userId: owner.userId, epoch: 2 });
  });
});

describe("stay operations", () => {
  let roomTypeId: string, guestId: string, rooms: { id: string; number: string }[];
  beforeAll(async () => {
    roomTypeId = (await createRoomType(app, owner, { name: "Std" })).id;
    rooms = [];
    for (const n of ["201", "202", "203"]) rooms.push(await createRoom(app, owner, { roomTypeId, number: n }));
    guestId = (await createGuest(app, owner, { name: "Stay Guest" })).id;
  });

  it("extends a stay but not into another guest's booking", async () => {
    const a = await createReservation(app, owner, { guestId, roomTypeId, arrival: "2032-05-01", departure: "2032-05-03" });
    expect(await changeDeparture(app, owner, a.id, "2032-05-05")).toMatchObject({ departure: "2032-05-05" });
    // block the other two rooms and the extension target of room A
    const b = await createReservation(app, owner, { guestId, roomTypeId, arrival: "2032-05-05", departure: "2032-05-08" });
    await expect(changeDeparture(app, owner, a.id, "2032-05-06")).rejects.toThrow(/booked by another/i);
    await expect(changeDeparture(app, owner, a.id, "2032-04-30")).rejects.toThrow();
    expect(b.roomId).toBeTruthy();
  });

  it("moves an in-house guest, marks the old room dirty, and rejects an occupied target", async () => {
    const r = await createReservation(app, owner, { guestId, roomTypeId, arrival: "2032-06-01", departure: "2032-06-04" });
    const other = await createReservation(app, owner, { guestId, roomTypeId, arrival: "2032-06-01", departure: "2032-06-04" });
    await checkIn(app, owner, r.id);
    await expect(moveRoom(app, owner, r.id, other.roomId, "upgrade")).rejects.toThrow(/not available/i);
    const free = await withTenant(app, owner.tenantId, (tx) => findFreeRooms(tx, owner.propertyId!, roomTypeId, "2032-06-01", "2032-06-04"));
    await expect(moveRoom(app, owner, r.id, free[0].id, " ")).rejects.toThrow(/reason/i);
    await moveRoom(app, owner, r.id, free[0].id, "AC fault");
    const old = await withTenant(app, owner.tenantId, (tx) => tx.room.findUniqueOrThrow({ where: { id: r.roomId } }));
    expect(old.housekeeping).toBe("DIRTY");
    expect(await withTenant(app, owner.tenantId, (tx) => tx.roomAssignment.count({ where: { reservationId: r.id, active: true } }))).toBe(1);
  });

  it("calendar returns assignments in range", async () => {
    const cal = await calendar(app, owner, "2032-06-01", 7);
    expect(cal.rooms.length).toBe(3);
    expect(cal.assignments.length).toBeGreaterThanOrEqual(2);
  });

  it("a blocking maintenance request removes the room from sale until resolved", async () => {
    const free = async () =>
      (await withTenant(app, owner.tenantId, (tx) => findFreeRooms(tx, owner.propertyId!, roomTypeId, "2033-01-01", "2033-01-02"))).length;
    expect(await free()).toBe(3);
    const m = await createMaintenanceRequest(app, owner, { roomId: rooms[0].id, title: "Leak", blocksRoom: true });
    expect(await free()).toBe(2);
    await resolveMaintenance(app, owner, m.id);
    expect(await free()).toBe(3);
    expect((await listMaintenance(app, owner)).find((x) => x.id === m.id)?.status).toBe("RESOLVED");
  });

  it("check-in is refused for a dirty room until housekeeping marks it clean", async () => {
    const soloType = (await createRoomType(app, owner, { name: "Solo" })).id;
    const solo = await createRoom(app, owner, { roomTypeId: soloType, number: "301" });
    await withTenant(app, owner.tenantId, (tx) => tx.room.update({ where: { id: solo.id }, data: { housekeeping: "DIRTY" } }));
    const r = await createReservation(app, owner, { guestId, roomTypeId: soloType, arrival: "2033-02-01", departure: "2033-02-02" });
    expect(r.roomId).toBe(solo.id);
    await expect(checkIn(app, owner, r.id)).rejects.toThrow(/not ready/i);
    await setRoomStatus(app, owner, solo.id, "CLEAN");
    await expect(checkIn(app, owner, r.id)).resolves.toBeTruthy();
  });

  it("an out-of-order room is never offered for sale", async () => {
    await withTenant(app, owner.tenantId, (tx) => tx.room.update({ where: { id: rooms[2].id }, data: { outOfOrder: true } }));
    const free = await withTenant(app, owner.tenantId, (tx) => findFreeRooms(tx, owner.propertyId!, roomTypeId, "2034-01-01", "2034-01-02"));
    expect(free.map((x) => x.id)).not.toContain(rooms[2].id);
  });
});
