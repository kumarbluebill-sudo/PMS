import { Card, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

type Row = { name: string; kind: string; state: string };
/** What is live today and what is not. Nothing planned is shown as connected. */
const ROWS: Row[] = [
  { name: "Email (Resend)", kind: "Guest confirmations and notices", state: "Live when the hotel's platform has an email key set; otherwise runs in test mode and says so on each message" },
  { name: "WhatsApp (Twilio)", kind: "Guest messages", state: "Live when Twilio credentials are set on the server" },
  { name: "Payment gateway", kind: "Online payments", state: "Not available" },
  { name: "Online travel agencies", kind: "Channel manager", state: "Not available" },
  { name: "Accounting export", kind: "Tally or other accounting software", state: "Not available" },
  { name: "Door locks and POS", kind: "Hardware", state: "Not available" },
];

export default async function Integrations() {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to integrations.</p>;
  return (
    <>
      <PageHeader title="Integrations" subtitle="Services connected to this system." />
      <Card title="Status">
        <p className="mb-3 text-sm text-slate-600">Secrets are held on the server and are never shown here. Anything marked not available has no working connection.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500"><tr><th className="py-1">Integration</th><th>Used for</th><th>Status</th></tr></thead>
            <tbody className="divide-y">
              {ROWS.map((r) => <tr key={r.name}><td className="py-1.5 font-medium">{r.name}</td><td>{r.kind}</td><td>{r.state}</td></tr>)}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
