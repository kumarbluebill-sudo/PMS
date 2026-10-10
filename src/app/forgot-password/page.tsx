import Link from "next/link";
import { forgotPasswordAction } from "@/app/account-actions";
import { btn, Field, input } from "@/app/ui";

export default async function ForgotPassword({ searchParams }: PageProps<"/forgot-password">) {
  const { ok } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Forgot password</h1>
      {typeof ok === "string" && (
        <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>
      )}
      <form action={forgotPasswordAction} className="space-y-3">
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" className={input} />
        </Field>
        <button className={`${btn} w-full`}>Send reset link</button>
      </form>
      <Link className="text-sm underline" href="/login">Back to sign in</Link>
    </main>
  );
}
