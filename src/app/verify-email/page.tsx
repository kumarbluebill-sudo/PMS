import { verifyEmailAction } from "@/app/account-actions";
import { btn } from "@/app/ui";

// Verification happens on POST so link scanners that prefetch the URL cannot consume the token.
export default async function VerifyEmail({ searchParams }: PageProps<"/verify-email">) {
  const { token } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Verify your email</h1>
      <form action={verifyEmailAction}>
        <input type="hidden" name="token" value={typeof token === "string" ? token : ""} />
        <button className={btn}>Confirm my email</button>
      </form>
    </main>
  );
}
