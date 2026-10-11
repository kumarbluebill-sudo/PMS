/** A sign-in older than the business's limit is no longer valid. Tokens without a sign-in time are left to the cookie's own expiry. */
export function isSessionExpired(authAt: number | undefined, limitMinutes: number, now: number): boolean {
  if (!authAt) return false;
  return now - authAt > limitMinutes * 60_000;
}
