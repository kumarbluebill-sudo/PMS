import { saveSettingsAction } from "@/app/settings-actions";
import { btn, Field, input } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import type { Ctx } from "@/server/auth/context";
import { DEFS, type SettingKey, type SettingValues } from "@/server/domain/settings";

/** Renders catalogue entries as a form. Types, limits and permissions all come from the catalogue. */
export function SettingsForm({
  keys, values, secretsSet, ctx, back,
}: { keys: SettingKey[]; values: SettingValues; secretsSet: ReadonlySet<string>; ctx: Ctx; back: string }) {
  const editable = keys.filter((k) => roleHasPermission(ctx.role, DEFS[k].perm, ctx.extra));
  return (
    <form action={saveSettingsAction} className="space-y-4">
      <input type="hidden" name="back" value={back} />
      {editable.map((k) => <input key={k} type="hidden" name="keys" value={k} />)}
      {keys.map((k) => {
        const d = DEFS[k];
        const v = values[k] as unknown;
        const can = editable.includes(k);
        const help = "help" in d && d.help ? <p className="text-xs text-slate-500">{d.help}</p> : null;
        if (d.control === "checkbox") {
          return (
            <div key={k}>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name={k} defaultChecked={v === true} disabled={!can} className="mt-0.5" />{d.label}</label>
              {help}
            </div>
          );
        }
        if (d.control === "multi") {
          const on = new Set(v as string[]);
          return (
            <fieldset key={k} className="space-y-1">
              <legend className="text-sm font-medium text-slate-700">{d.label}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {d.options?.map((o) => (
                  <label key={o.value} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name={k} value={o.value} defaultChecked={on.has(o.value)} disabled={!can} />{o.label}</label>
                ))}
              </div>
              {help}
            </fieldset>
          );
        }
        const shown =
          k === "billing.refundApprovalLimitMinor" ? String((v as number) / 100)
          : k === "rooms.housekeepingCategories" ? (v as string[]).join("\n")
          : String(v ?? "");
        return (
          <div key={k} className="space-y-1">
            <Field label={d.label}>
              {d.control === "textarea" ? (
                <textarea name={k} rows={3} defaultValue={shown} disabled={!can} className={input} />
              ) : d.control === "select" ? (
                <select name={k} defaultValue={shown} disabled={!can} className={input}>{d.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              ) : d.control === "number" ? (
                <input name={k} type="number" step={k === "billing.refundApprovalLimitMinor" ? "0.01" : 1} min={"min" in d ? d.min : undefined} max={"max" in d ? d.max : undefined} defaultValue={shown} disabled={!can} className={input} />
              ) : d.control === "secret" ? (
                <input name={k} type="password" autoComplete="new-password" placeholder={secretsSet.has(k) ? "Saved (enter a new value to replace)" : "Not set"} disabled={!can} className={input} />
              ) : (
                <input name={k} defaultValue={shown} disabled={!can} className={input} />
              )}
            </Field>
            {help}
          </div>
        );
      })}
      {editable.length > 0 ? <button className={btn}>Save</button> : <p className="text-sm text-slate-500">You can view these settings but not change them.</p>}
    </form>
  );
}
