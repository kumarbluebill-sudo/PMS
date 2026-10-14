import { acceptInviteAction } from "@/app/account-actions";
import AuthShell from "@/components/AuthShell";
import { btn, ErrorBanner, Field, input } from "@/app/ui";

export default async function Invite({ searchParams }: PageProps<"/invite">) {
  const { token, error } = await searchParams;
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold">Accept your invitation</h1>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <form action={acceptInviteAction} className="space-y-3">
        <input type="hidden" name="token" value={typeof token === "string" ? token : ""} />
        <Field label="Your name">
          <input name="name" required autoComplete="name" className={input} />
        </Field>
        <Field label="Password (10+ characters)">
          <input name="password" type="password" minLength={10} required autoComplete="new-password" className={input} />
        </Field>
        <button className={`${btn} w-full`}>Create my account</button>
      </form>
    </AuthShell>
  );
}
