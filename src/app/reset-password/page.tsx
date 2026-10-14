import { resetPasswordAction } from "@/app/account-actions";
import AuthShell from "@/components/AuthShell";
import { btn, ErrorBanner, Field, input } from "@/app/ui";

export default async function ResetPassword({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <form action={resetPasswordAction} className="space-y-3">
        <input type="hidden" name="token" value={typeof token === "string" ? token : ""} />
        <Field label="New password (10+ characters)">
          <input name="password" type="password" minLength={10} required autoComplete="new-password" className={input} />
        </Field>
        <button className={`${btn} w-full`}>Update password</button>
      </form>
      <p className="text-xs text-slate-500">Updating your password signs you out everywhere.</p>
    </AuthShell>
  );
}
