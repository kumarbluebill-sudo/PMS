import type { Metadata } from "next";
import { contactAction } from "@/app/public-actions";
import { btn, ErrorBanner, Field, input, Notice } from "@/app/ui";
import { PublicPage } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Contact and demo | MK Hotel PMS",
  description: "Ask for a demo or write to the MK Solutions team about hotel management software for your property.",
  alternates: { canonical: "/contact" },
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function Contact({ searchParams }: PageProps<"/contact">) {
  const sp = await searchParams;
  const demo = one(sp.demo) === "1";
  return (
    <PublicPage>
      <section className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-slate-900">{demo ? "Ask for a demo" : "Talk to us"}</h1>
        <p className="mt-2 text-slate-700">Tell us about your hotel and we will get back to you by phone or email.</p>
        <div className="mt-5">
          <ErrorBanner message={one(sp.error) || undefined} />
          {one(sp.sent) === "1" && <Notice tone="success">Thank you. We have your details and will contact you soon.</Notice>}
        </div>
        {one(sp.sent) !== "1" && (
          <form action={contactAction} className="mt-2 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="kind" value={demo ? "DEMO" : "CONTACT"} />
            <Field label="Your name"><input name="name" required autoComplete="name" className={input} /></Field>
            <Field label="Hotel name"><input name="hotel" required autoComplete="organization" className={input} /></Field>
            <Field label="Mobile number"><input name="mobile" type="tel" required autoComplete="tel" inputMode="tel" className={input} /></Field>
            <Field label="Email"><input name="email" type="email" required autoComplete="email" className={input} /></Field>
            <Field label="Number of rooms"><input name="rooms" type="number" min={1} max={5000} inputMode="numeric" className={input} /></Field>
            <Field label="Number of properties"><input name="properties" type="number" min={1} max={500} inputMode="numeric" className={input} /></Field>
            <div className="sm:col-span-2"><Field label="Integrations you need (for example booking sites or accounting)"><input name="integrations" maxLength={300} className={input} /></Field></div>
            <div className="sm:col-span-2"><Field label="Anything else"><textarea name="message" rows={4} maxLength={2000} className={input} /></Field></div>
            {/* Hidden from people; bots tend to fill every field. */}
            <div aria-hidden className="absolute left-[-9999px]"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
            <div className="sm:col-span-2"><button className={btn}>{demo ? "Request a demo" : "Send message"}</button></div>
          </form>
        )}
      </section>
    </PublicPage>
  );
}
