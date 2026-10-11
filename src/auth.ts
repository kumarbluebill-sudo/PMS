import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { verifyCredentials } from "@/server/services/tenant";
import { rateLimit } from "@/server/rateLimit";
import { checkTotp, recordAuthEvent } from "@/server/services/accounts";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [
    Credentials({
      authorize: async (raw) => {
        const p = z.object({ email: z.string().email(), password: z.string().min(1), code: z.string().optional() }).safeParse(raw);
        if (!p.success) return null;
        // Brute-force protection: 8 attempts / 15 min per email.
        if (!rateLimit(`login:${p.data.email.toLowerCase()}`, 8, 15 * 60_000)) return null;
        const user = await verifyCredentials(getDb(), p.data.email, p.data.password);
        if (!user) {
          // Log the failure against the account's businesses when the email exists (never reveals anything to the caller).
          const known = await getDb().user.findUnique({ where: { email: p.data.email.trim().toLowerCase() }, select: { id: true } }).catch(() => null);
          if (known) await recordAuthEvent(getDb(), known.id, "auth.login_failed", "wrong password or inactive").catch(() => {});
          return null;
        }
        // Second factor: required whenever the user has enrolled.
        if (user.mfaEnabled && !(user.mfaSecretEnc && (await checkTotp(user.mfaSecretEnc, p.data.code ?? "")))) {
          await recordAuthEvent(getDb(), user.id, "auth.login_failed", "second factor").catch(() => {});
          return null;
        }
        await recordAuthEvent(getDb(), user.id, "auth.login").catch(() => {});
        return { id: user.id, name: user.name, email: user.email, epoch: user.sessionEpoch } as never;
      },
    }),
  ],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.uid = user.id;
        token.epoch = (user as unknown as { epoch: number }).epoch;
        token.authAt = Date.now(); // when this sign-in happened, for the business's session time limit
      }
      return token;
    },
    // Only identifiers travel in the cookie; role/tenant are always re-read from the DB.
    session: ({ session, token }) => {
      (session as unknown as { uid: string; epoch: number }).uid = token.uid as string;
      (session as unknown as { uid: string; epoch: number }).epoch = token.epoch as number;
      (session as unknown as { authAt?: number }).authAt = token.authAt as number | undefined;
      return session;
    },
  },
});
