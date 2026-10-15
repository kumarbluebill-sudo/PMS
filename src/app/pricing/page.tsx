import type { Metadata } from "next";
import Link from "next/link";
import { btn } from "@/app/ui";
import { PublicPage } from "@/components/PublicChrome";
import { getDb } from "@/server/db/client";
import { FEATURES, hasFeature, planPrice } from "@/server/domain/subscription";
import { listPublicPlans } from "@/server/services/publicSite";

export const metadata: Metadata = {
  title: "Pricing | MK Hotel PMS",
  description: "Simple monthly and yearly plans for hotels in India: reservations, front desk, housekeeping and GST billing. Start with a free trial.",
  alternates: { canonical: "/pricing" },
};
export const dynamic = "force-dynamic";

const FAQ: { q: string; a: string }[] = [
  { q: "How long does setup take?", a: "A small hotel can add its rooms, rates and GST details in an afternoon with the setup guide. Rooms can be added in bulk or imported from a spreadsheet." },
  { q: "Do you provide training?", a: "The Help & Support section has step-by-step guides. Growth and Enterprise plans include priority support, and Enterprise includes a dedicated account manager." },
  { q: "What happens to my data?", a: "It is stored in a managed cloud database. You can export all of it to Excel at any time, even if a subscription has ended. Nothing is deleted when a payment is missed." },
  { q: "Can I connect Booking.com or other travel agencies?", a: "Not yet. The channel manager is planned and shows every connection as not available until it works. We will not show a channel as connected before it is." },
  { q: "Can I cancel?", a: "Yes, any time. Your plan keeps working until the end of the period you paid for. After that the account becomes read-only and you can still view and export everything." },
  { q: "How is GST handled?", a: "Prices here are before GST, which is added on your subscription invoice. Your own guest invoices use rules you set up and your accountant approves." },
  { q: "How do I pay?", a: "By bank transfer or UPI against an invoice. Online card payment is not available yet." },
];

const inr = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const lim = (n: number | null, one: string, many: string) => (n == null ? `Unlimited ${many}` : `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`);

export default async function Pricing({ searchParams }: PageProps<"/pricing">) {
  const sp = await searchParams;
  const annual = sp.billing === "annual";
  const { plans, addons, gstBps } = await listPublicPlans(getDb());
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mk-pms-hotel.vercel.app";
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      ...plans.filter((p) => !p.customPricing).map((p) => ({
        "@type": "Product", name: `MK Hotel PMS ${p.name}`, description: p.description,
        offers: { "@type": "Offer", priceCurrency: "INR", price: (planPrice(p, annual ? "ANNUAL" : "MONTHLY") / 100).toFixed(2), url: `${base}/pricing`, availability: "https://schema.org/InStock" },
      })),
      { "@type": "FAQPage", mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
    ],
  };
  return (
    <PublicPage>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <section className="mx-auto max-w-6xl px-4 pb-6 pt-8">
        <h1 className="text-3xl font-semibold text-slate-900 md:text-4xl">Pricing for hotels of every size</h1>
        <p className="mt-2 max-w-xl text-slate-700">Start with a free trial. Pick monthly or yearly billing. Prices are before {gstBps / 100}% GST, which is added on your invoice.</p>
        <div role="group" aria-label="Billing period" className="mt-5 inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          <Link href="/pricing" aria-current={!annual ? "true" : undefined} className={`rounded px-4 py-1.5 font-medium ${!annual ? "bg-brand-800 text-white" : "text-slate-800 hover:bg-slate-50"}`}>Monthly</Link>
          <Link href="/pricing?billing=annual" aria-current={annual ? "true" : undefined} className={`rounded px-4 py-1.5 font-medium ${annual ? "bg-brand-800 text-white" : "text-slate-800 hover:bg-slate-50"}`}>Yearly</Link>
        </div>
      </section>

      <section aria-label="Plans" className="mx-auto grid max-w-6xl gap-4 px-4 pb-10 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => {
          const price = planPrice(p, annual ? "ANNUAL" : "MONTHLY");
          return (
            <article key={p.id} className="flex flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(26,32,26,0.05)]">
              <h2 className="text-lg font-semibold text-slate-900">{p.name}</h2>
              <p className="mt-1 min-h-[3.5rem] text-sm text-slate-700">{p.description}</p>
              <p className="mt-3">
                {p.customPricing ? <span className="text-sm text-slate-700">from </span> : null}
                <span className="text-3xl font-semibold text-slate-900">{inr(annual && !p.customPricing ? Math.round(price / 12) : p.customPricing ? p.monthlyPriceMinor : price)}</span>
                <span className="text-sm text-slate-700"> per month</span>
              </p>
              <p className="min-h-[1.25rem] text-xs text-slate-600">
                {p.customPricing ? "Priced for your group. Talk to sales." : annual ? `${inr(price)} billed yearly` : "Billed monthly"}
              </p>
              <ul className="mt-4 space-y-1 text-sm text-slate-800">
                <li>{lim(p.maxProperties, "property", "properties")}</li>
                <li>{lim(p.maxRooms, "room", "rooms")}</li>
                <li>{lim(p.maxUsers, "user", "users")}</li>
                {p.trialDays > 0 && !p.customPricing && <li>{p.trialDays}-day free trial</li>}
              </ul>
              <div className="mt-auto pt-5">
                {p.customPricing ? (
                  <Link href="/contact?demo=1" className={`${btn} w-full`}>Talk to sales</Link>
                ) : (
                  <Link href={`/register?plan=${p.code}`} className={`${btn} w-full`}>Start free trial</Link>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <section aria-labelledby="compare" className="mx-auto max-w-6xl px-4 pb-10">
        <h2 id="compare" className="text-xl font-semibold text-slate-900">What each plan includes</h2>
        <div className="relative mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Feature comparison between plans</caption>
            <thead className="bg-slate-50 text-xs text-slate-700">
              <tr><th scope="col" className="p-3">Feature</th>{plans.map((p) => <th scope="col" key={p.id} className="p-3">{p.name}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {FEATURES.map((f) => (
                <tr key={f.key}>
                  <th scope="row" className="p-3 font-normal text-slate-900">{f.label}</th>
                  {plans.map((p) => <td key={p.id} className="p-3">{hasFeature(p, f.key) ? <span><span aria-hidden>✓</span><span className="sr-only">Included</span></span> : <span className="text-slate-500"><span aria-hidden>–</span><span className="sr-only">Not included</span></span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {addons.length > 0 && (
        <section aria-labelledby="addons" className="mx-auto max-w-6xl px-4 pb-10">
          <h2 id="addons" className="text-xl font-semibold text-slate-900">Add-ons</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {addons.map((a) => (
              <li key={a.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="font-medium text-slate-900">{a.name}</p>
                <p className="text-sm text-slate-700">{a.description}</p>
                <p className="mt-1 text-sm">{inr(a.monthlyPriceMinor)} per month</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="faq" className="mx-auto max-w-3xl px-4 pb-14">
        <h2 id="faq" className="text-xl font-semibold text-slate-900">Questions</h2>
        <dl className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {FAQ.map((f) => (
            <div key={f.q} className="p-4">
              <dt className="font-medium text-slate-900">{f.q}</dt>
              <dd className="mt-1 text-sm text-slate-700">{f.a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-sm text-slate-700">Not sure which plan fits? <Link className="font-medium text-brand-800 underline" href="/contact?demo=1">Ask for a demo</Link>.</p>
      </section>
    </PublicPage>
  );
}
