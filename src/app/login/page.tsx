import Link from "next/link";
import AuthShell from "@/components/AuthShell";
import { loginAction } from "@/app/actions";
import { btn, ErrorBanner, Field, input } from "@/app/ui";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error, ok } = await searchParams;
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>}
      <form action={loginAction} className="space-y-3">
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" className={input} />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required autoComplete="current-password" className={input} />
        </Field>
        <Field label="Authenticator code (only if MFA is enabled)">
          <input name="code" inputMode="numeric" autoComplete="one-time-code" className={input} />
        </Field>
        <button className={`${btn} w-full`}>Sign in</button>
      </form>
      <Link className="text-sm underline" href="/forgot-password">Forgot password?</Link>
      <p className="text-sm text-slate-600">
        New hotel?{" "}
        <Link className="underline" href="/register">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
