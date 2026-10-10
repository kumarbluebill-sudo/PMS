export const PERMISSIONS = [
  "reservations.view",
  "reservations.create",
  "reservations.modify",
  "reservations.cancel",
  "frontdesk.checkin",
  "frontdesk.checkout",
  "guests.view",
  "guests.viewSensitive",
  "guests.manage",
  "rooms.view",
  "rooms.manage",
  "housekeeping.view",
  "housekeeping.update",
  "housekeeping.manage",
  "maintenance.manage",
  "rates.manage",
  "finance.view",
  "reports.export",
  "users.manage",
  "roles.manage",
  "audit.view",
  "channels.manage",
  "subscription.manage",
  "backup.configure",
  "settings.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "PLATFORM_SUPER_ADMIN",
  "SAAS_SUPPORT_ADMIN",
  "HOTEL_OWNER",
  "GROUP_ADMIN",
  "GENERAL_MANAGER",
  "PROPERTY_MANAGER",
  "FRONT_DESK",
  "RESERVATION_EXECUTIVE",
  "ACCOUNTS_MANAGER",
  "CASHIER",
  "HOUSEKEEPING",
  "MAINTENANCE",
  "REVENUE_MANAGER",
  "AUDITOR",
] as const;

export type RoleKey = (typeof ROLES)[number];

/** Roles that must enrol in TOTP MFA before using the app. */
export const MFA_REQUIRED_ROLES: readonly RoleKey[] = [
  "HOTEL_OWNER", "GROUP_ADMIN", "GENERAL_MANAGER", "PROPERTY_MANAGER", "ACCOUNTS_MANAGER",
];

const ALL: Permission[] = [...PERMISSIONS];

const MANAGER: Permission[] = ALL.filter(
  (p) => !["subscription.manage", "backup.configure"].includes(p),
);

/**
 * Default permission matrix. Platform roles are tenant-agnostic and are
 * deliberately excluded from tenant data permissions: cross-tenant access
 * goes through explicit, audited platform functions, not this matrix.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  PLATFORM_SUPER_ADMIN: [],
  SAAS_SUPPORT_ADMIN: [],
  HOTEL_OWNER: ALL,
  GROUP_ADMIN: ALL,
  GENERAL_MANAGER: MANAGER,
  PROPERTY_MANAGER: MANAGER.filter((p) => p !== "roles.manage"),
  FRONT_DESK: [
    "reservations.view",
    "reservations.create",
    "reservations.modify",
    "frontdesk.checkin",
    "frontdesk.checkout",
    "guests.view",
    "guests.viewSensitive",
    "guests.manage",
    "rooms.view",
    "housekeeping.view",
  ],
  RESERVATION_EXECUTIVE: [
    "reservations.view",
    "reservations.create",
    "reservations.modify",
    "reservations.cancel",
    "guests.view",
    "guests.manage",
    "rooms.view",
  ],
  ACCOUNTS_MANAGER: ["reservations.view", "guests.view", "finance.view", "reports.export", "audit.view"],
  CASHIER: ["reservations.view", "guests.view", "finance.view", "frontdesk.checkout"],
  HOUSEKEEPING: ["rooms.view", "housekeeping.view", "housekeeping.update"],
  MAINTENANCE: ["rooms.view", "maintenance.manage"],
  REVENUE_MANAGER: ["reservations.view", "rooms.view", "rates.manage", "finance.view", "reports.export"],
  AUDITOR: ["reservations.view", "guests.view", "rooms.view", "finance.view", "audit.view"],
};

export function roleHasPermission(
  role: RoleKey,
  permission: Permission,
  extraGrants: readonly Permission[] = [],
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission) || extraGrants.includes(permission);
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: Permission) {
    super("You do not have permission to perform this action.");
    this.name = "ForbiddenError";
  }
}

export function assertPermission(
  role: RoleKey,
  permission: Permission,
  extraGrants: readonly Permission[] = [],
): void {
  if (!roleHasPermission(role, permission, extraGrants)) throw new ForbiddenError(permission);
}
