import { Card, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listAuditLogs } from "@/server/services/audit";

export default async function AuditLogs() {
  const logs = await listAuditLogs(getDb(), await getCtx());
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only. Entries cannot be edited or deleted." />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr><th className="py-1">Time (UTC)</th><th>Action</th><th>Entity</th><th>Reason</th></tr>
            </thead>
            <tbody className="divide-y">
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 whitespace-nowrap">{l.at.toISOString().replace("T", " ").slice(0, 19)}</td>
                  <td>{l.action}</td>
                  <td className="font-mono text-xs">{l.entityType}</td>
                  <td>{l.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
