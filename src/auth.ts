import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { verifyCredentials } from "@/server/services/tenant";
import { rateLimit } from "@/server/rateLimit";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [
    Credentials({
      authorize: async (raw) => {
        const p = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(raw);
        if (!p.success) return null;
        // Brute-force protection: 8 attempts / 15 min per email.
        if (!rateLimit(`login:${p.data.email.toLowerCase()}`, 8, 15 * 60_000)) return null;
        const user = await verifyCredentials(getDb(), p.data.email, p.data.password);
        if (!user) return null;
        return { id: user.id, name: user.name, email: user.email, epoch: user.sessionEpoch } as never;
      },
    }),
  ],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.uid = user.id;
        token.epoch = (user as unknown as { epoch: number }).epoch;
      }
      return token;
    },
    // Only identifiers travel in the cookie; role/tenant are always re-read from the DB.
    session: ({ session, token }) => {
      (session as unknown as { uid: string; epoch: number }).uid = token.uid as string;
      (session as unknown as { uid: string; epoch: number }).epoch = token.epoch as number;
      return session;
    },
  },
});
