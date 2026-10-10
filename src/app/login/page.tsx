import Link from "next/link";
import { loginAction } from "@/app/actions";
import { btn, ErrorBanner, Field, input } from "@/app/ui";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <form action={loginAction} className="space-y-3">
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" className={input} />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required autoComplete="current-password" className={input} />
        </Field>
        <button className={`${btn} w-full`}>Sign in</button>
      </form>
      <p className="text-sm text-slate-600">
        New hotel?{" "}
        <Link className="underline" href="/register">
          Create an account
        </Link>
      </p>
    </main>
  );
}
