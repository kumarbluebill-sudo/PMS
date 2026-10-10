import Link from "next/link";
import { mfaBeginAction, mfaConfirmAction } from "@/app/account-actions";
import { btn, Card, ErrorBanner, Field, input } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { decryptSecret } from "@/server/crypto";
import { getCtx } from "@/server/session";
import { mfaRequired } from "@/server/services/accounts";
import { generateURI } from "otplib";

export default async function Security({ searchParams }: PageProps<"/security">) {
  const { error, ok } = await searchParams;
  const ctx = await getCtx({ allowMfaSetup: true });
  const user = await getDb().user.findUniqueOrThrow({ where: { id: ctx.userId } });
  const pending = !user.mfaEnabled && user.mfaSecretEnc ? decryptSecret(user.mfaSecretEnc) : null;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {user.mfaEnabled ? (
        <Card>
          <p className="text-sm">
            MFA is <strong>enabled</strong> on your account.{" "}
            <Link className="underline" href="/app/dashboard">Continue to the app</Link>
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Lost your device? A hotel owner can reset your MFA from Users. There are no recovery codes yet.
          </p>
        </Card>
      ) : (
        <Card>
          {mfaRequired(ctx.role) && (
            <p className="mb-3 text-sm text-amber-800">Your role requires MFA before you can use the system.</p>
          )}
          {!pending ? (
            <form action={mfaBeginAction}>
              <button className={btn}>Set up authenticator app</button>
            </form>
          ) : (
            <div className="space-y-3 text-sm">
              <p>
                Add this key in an authenticator app (Google Authenticator, Authy, 1Password): manual entry, time-based.
              </p>
              <p className="break-all rounded bg-slate-100 p-2 font-mono text-xs">{pending}</p>
              <p className="break-all text-xs text-slate-500">
                or open: {generateURI({ issuer: "MK Hotel PMS", label: user.email, secret: pending })}
              </p>
              <form action={mfaConfirmAction} className="space-y-2">
                <Field label="6-digit code">
                  <input name="code" inputMode="numeric" pattern="\d{6}" required autoComplete="one-time-code" className={input} />
                </Field>
                <button className={btn}>Confirm and enable</button>
              </form>
            </div>
          )}
        </Card>
      )}
      {typeof ok === "string" && <p className="text-sm text-green-800">{ok}</p>}
    </main>
  );
}
