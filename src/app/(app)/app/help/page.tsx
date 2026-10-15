import Link from "next/link";
import { Card, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

const GUIDES: { title: string; steps: string[] }[] = [
  {
    title: "Set up GST",
    steps: [
      "Open Settings > GST & tax and choose the setup wizard.",
      "Enter the legal name, GSTIN and state. The GSTIN is checked for format only, not against the government portal.",
      "Apply the accommodation preset, then add a rule for every other service you sell (restaurant, banquet, laundry).",
      "A second authorised person approves each rule. Ask your accountant to check every rate against the official notification first.",
      "Use the preview calculator, then confirm the setup.",
    ],
  },
  {
    title: "Add rooms and categories",
    steps: [
      "Open Room Inventory and add floors, then room categories with occupancy and base rate.",
      "Add rooms one by one, in bulk, or import them from a spreadsheet.",
      "Create rate plans for seasons or channels.",
    ],
  },
  {
    title: "Take a booking from arrival to bill",
    steps: [
      "Create the reservation, allocate a room, then check the guest in from Front Desk.",
      "Post charges and payments to the folio during the stay.",
      "At check-out, review the folio and issue the invoice. Corrections go through a credit or debit note.",
    ],
  },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Why can I not issue an invoice?", a: "GST setup must be complete and at least one approved tax rule must cover each charge. The Invoices page shows what is missing." },
  { q: "Can I edit an issued invoice?", a: "No. Issued invoices are locked. Issue a credit note or debit note linked to the original." },
  { q: "Are online travel agencies connected?", a: "Not yet. Channel Manager and Integrations list what is planned and show every provider as not connected." },
  { q: "Who can approve a tax rule?", a: "Someone with the tax approval permission who is not the person that created the rule." },
];

export default async function HelpPage() {
  const ctx = await getCtx();
  const admin = roleHasPermission(ctx.role, "settings.view", ctx.extra);
  return (
    <>
      <PageHeader title="Help & Support" subtitle="Setup guides and answers to common questions." />
      <div className="grid gap-4 lg:grid-cols-2">
        {GUIDES.map((g) => (
          <Card key={g.title} title={g.title}>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
              {g.steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
          </Card>
        ))}
        <Card title="Common questions">
          <dl className="space-y-3 text-sm">
            {FAQ.map((f) => (
              <div key={f.q}>
                <dt className="font-medium text-slate-900">{f.q}</dt>
                <dd className="text-slate-600">{f.a}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Contact support">
          <p className="text-sm text-slate-700">
            Write to your account manager or the MK Solutions support team and include your hotel name and the page you were on.
          </p>
          {admin && (
            <p className="mt-2 text-sm">
              <Link href="/app/settings/subscription" className="text-brand-700 hover:underline">View your plan and subscription</Link>
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
