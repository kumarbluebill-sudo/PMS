import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k) throw new Error("APP_ENCRYPTION_KEY is not set");
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return buf;
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
