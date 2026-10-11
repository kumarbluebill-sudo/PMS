import { Card, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

/** Provider names are a catalogue of what is planned. Nothing here can show "Connected": no connection can be made yet. */
const PROVIDERS = ["Booking.com", "Expedia", "Agoda", "Airbnb", "MakeMyTrip / Goibibo"];

export default async function ChannelSettings() {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to these settings.</p>;
  return (
    <>
      <PageHeader title="Channel manager" subtitle="Connections to online travel agencies." />
      <Card title="Connections">
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The channel manager is not built yet. No provider can be connected, so nothing is synchronised and no channel shows as connected.
          Room and rate-plan mapping, sync frequency and retry rules will appear here once a provider integration exists (each needs its own partner account and credentials).
        </p>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="py-1">Provider</th><th>Status</th><th>Credentials</th><th>Last sync</th></tr></thead>
          <tbody className="divide-y">
            {PROVIDERS.map((p) => <tr key={p}><td className="py-1.5">{p}</td><td>Not available</td><td>Not configured</td><td>Never</td></tr>)}
          </tbody>
        </table>
      </Card>
    </>
  );
}
