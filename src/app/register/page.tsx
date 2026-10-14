import Link from "next/link";
import AuthShell from "@/components/AuthShell";
import { registerAction } from "@/app/actions";
import { btn, ErrorBanner, Field, input } from "@/app/ui";

export default async function RegisterPage({ searchParams }: PageProps<"/register">) {
  const { error } = await searchParams;
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold">Create your hotel account</h1>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <form action={registerAction} className="space-y-3">
        <Field label="Business name">
          <input name="businessName" required className={input} />
        </Field>
        <Field label="First property name">
          <input name="propertyName" required className={input} />
        </Field>
        <Field label="Your name">
          <input name="name" required autoComplete="name" className={input} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" className={input} />
        </Field>
        <Field label="Password (10+ characters)">
          <input name="password" type="password" minLength={10} required autoComplete="new-password" className={input} />
        </Field>
        <button className={`${btn} w-full`}>Create account</button>
      </form>
      <p className="text-sm text-slate-600">
        Already registered?{" "}
        <Link className="underline" href="/login">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
