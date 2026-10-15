import Link from "next/link";
import { saveSettingsAction } from "@/app/settings-actions";
import { btn, Card, ErrorBanner, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { INVOICE_FONTS, INVOICE_THEMES, THEME_LABELS, isHexColour } from "@/server/domain/invoiceTheme";
import { getCtx } from "@/server/session";
import { settingsFor } from "@/server/services/settings";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function InvoiceDesign({ searchParams }: PageProps<"/app/settings/invoice-design">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const st = await settingsFor(getDb(), ctx);
  const canSave = roleHasPermission(ctx.role, "settings.manage", ctx.extra);
  const theme = (INVOICE_THEMES as readonly string[]).includes(one(sp.theme)) ? one(sp.theme) : st["billing.theme"];
  const accent = typeof sp.accent === "string" ? (isHexColour(sp.accent) ? sp.accent : "") : st["billing.accentColor"];
  const font = typeof sp.font === "string" ? ((INVOICE_FONTS as readonly string[]).includes(sp.font) ? sp.font : "") : st["billing.font"];
  const src = `/app/settings/invoice-design/preview?${new URLSearchParams({ theme, accent, font })}`;
  const dirty = theme !== st["billing.theme"] || accent !== st["billing.accentColor"] || font !== st["billing.font"];

  return (
    <>
      <Breadcrumbs items={[{ label: "Settings", href: "/app/settings" }, { label: "Invoice design" }]} />
      <PageHeader title="Invoice design" subtitle="Pick a theme and see it on a sample invoice. A theme changes colours and type only; amounts, GST lines and legal details are always the same." />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="Choose a look">
            <form method="get" className="space-y-3">
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-700">Theme</legend>
                {INVOICE_THEMES.map((t) => (
                  <label key={t} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-2 text-sm has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
                    <input type="radio" name="theme" value={t} defaultChecked={theme === t} className="mt-1" />
                    <span><span className="block font-medium text-slate-900">{THEME_LABELS[t].name}</span><span className="block text-xs text-slate-600">{THEME_LABELS[t].blurb}</span></span>
                  </label>
                ))}
              </fieldset>
              <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Accent colour (optional)</span>
                <input name="accent" defaultValue={accent} placeholder="#0f766e" pattern="#[0-9a-fA-F]{6}" className={input} /></label>
              <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Typeface</span>
                <select name="font" defaultValue={font} className={input}>
                  <option value="">Theme default</option><option value="HELVETICA">Helvetica (sans-serif)</option><option value="TIMES">Times (serif)</option><option value="COURIER">Courier (monospace)</option>
                </select></label>
              <button className={btn}>Update preview</button>
            </form>
          </Card>
          {canSave ? (
            <Card title="Use this design">
              <form action={saveSettingsAction} className="space-y-2">
                <input type="hidden" name="back" value="/app/settings/invoice-design" />
                {["billing.theme", "billing.accentColor", "billing.font"].map((k) => <input key={k} type="hidden" name="keys" value={k} />)}
                <input type="hidden" name="billing.theme" value={theme} />
                <input type="hidden" name="billing.accentColor" value={accent} />
                <input type="hidden" name="billing.font" value={font} />
                <button className={btn} disabled={!dirty}>Save as the invoice design</button>
                <p className="text-xs text-slate-600">{dirty ? "This preview is not saved yet." : "This is the design in use."} The design is applied when an invoice PDF is opened; the saved invoice data never changes.</p>
              </form>
            </Card>
          ) : <p className="text-xs text-slate-600">You can preview designs. Saving needs the settings permission.</p>}
          <p className="text-xs text-slate-600">Header line, payment instructions, terms and the signature label are edited under <Link className="underline" href="/app/settings/billing">Invoice settings</Link>. Logo upload is not available yet.</p>
        </div>
        <Card title="Sample invoice">
          <iframe key={src} src={src} title="Sample invoice preview" className="h-[70vh] min-h-[32rem] w-full rounded border border-slate-200 bg-slate-50" />
        </Card>
      </div>
    </>
  );
}
