import { retryMessageAction, saveTemplateAction } from "./actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { TEMPLATE_LABELS, TEMPLATE_VARS, type TemplateKey } from "@/server/messaging/templates";
import { listMessages, listTemplates, messagingStatus } from "@/server/services/messaging";
import { getCtx } from "@/server/session";

const STATUS_TEXT: Record<string, string> = { PENDING: "Pending", SENT: "Sent", DELIVERED: "Delivered", FAILED: "Failed", TEST: "Test only (not delivered)" };

export default async function Messages({ searchParams }: PageProps<"/app/messages">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const [logs, templates] = await Promise.all([listMessages(db, ctx), roleHasPermission(ctx.role, "settings.view", ctx.extra) ? listTemplates(db, ctx) : Promise.resolve([])]);
  const canManage = roleHasPermission(ctx.role, "settings.manage", ctx.extra);
  const canSend = roleHasPermission(ctx.role, "guests.manage", ctx.extra);
  const st = messagingStatus();
  return (
    <>
      <PageHeader title="WhatsApp messages" subtitle="Templates, consent and delivery status" />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      {typeof sp.ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{sp.ok}</p>}
      <p role="status" className={`mb-4 rounded-md border px-3 py-2 text-sm ${st.configured ? "border-green-200 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
        {st.configured
          ? "WhatsApp provider connected. Messages are sent through Twilio."
          : "WhatsApp is not connected, so the app is in test mode: messages are recorded as “Test only” and nothing is delivered. An administrator sets TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM in the hosting environment to go live."}
      </p>
      <div className="space-y-4">
        <Card title="Recent messages">
          {logs.length === 0 ? <p className="text-sm text-slate-500">No messages yet. Send one from a reservation.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-600"><tr><th className="p-1">When</th><th>Guest</th><th>Booking</th><th>Message</th><th>To</th><th>Status</th><th></th></tr></thead>
                <tbody className="divide-y">
                  {logs.map((m) => (
                    <tr key={m.id} className="align-top">
                      <td className="p-1 whitespace-nowrap">{m.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                      <td>{m.guestName}</td>
                      <td className="font-mono text-xs">{m.reference ?? "—"}</td>
                      <td>{TEMPLATE_LABELS[m.templateKey as TemplateKey] ?? m.templateKey}</td>
                      <td className="font-mono text-xs">{m.toMasked}</td>
                      <td><Badge value={STATUS_TEXT[m.status] ?? m.status} />{m.error && <span className="block text-xs text-red-700">{m.error}</span>}</td>
                      <td>
                        {m.status === "FAILED" && canSend && (
                          <form action={retryMessageAction}><input type="hidden" name="id" value={m.id} /><button className={btnGhost}>Retry</button></form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {templates.length > 0 && (
          <Card title="Message templates">
            <p className="mb-3 text-xs text-slate-600">
              Variables: {TEMPLATE_VARS.map((v) => `{{${v}}}`).join(", ")}. WhatsApp requires pre-approved templates for messages sent outside a 24-hour conversation: paste the approved Twilio Content SID where you have one.
            </p>
            <div className="space-y-4">
              {templates.map((t) => (
                <form key={t.key} action={saveTemplateAction} className="space-y-2 border-b pb-4 last:border-0">
                  <input type="hidden" name="key" value={t.key} />
                  <Field label={TEMPLATE_LABELS[t.key]}>
                    <textarea name="body" rows={2} defaultValue={t.body} disabled={!canManage} className={input} />
                  </Field>
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Twilio Content SID (optional)"><input name="contentSid" defaultValue={t.contentSid} disabled={!canManage} className={input} placeholder="HX…" /></Field>
                    <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="active" defaultChecked={t.active} disabled={!canManage} /> Active</label>
                    {canManage && <button className={btn}>Save</button>}
                  </div>
                </form>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
