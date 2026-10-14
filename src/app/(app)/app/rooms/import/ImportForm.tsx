"use client";

import { useActionState } from "react";
import { btn, btnGhost, input } from "@/app/ui";
import { importRoomsAction, type ImportState } from "./actions";

export default function ImportForm() {
  const [state, action, pending] = useActionState<ImportState, FormData>(importRoomsAction, {});
  const ok = state.preview && state.preview.errors.length === 0 && state.preview.rows.length > 0;
  return (
    <form action={action} className="space-y-3">
      <input type="file" name="file" accept=".csv,.xlsx" required aria-label="Rooms file" className={input} />
      <div className="flex flex-wrap gap-2">
        <button name="mode" value="preview" disabled={pending} className={btnGhost}>{pending ? "Checking…" : "Check file"}</button>
        <button name="mode" value="commit" disabled={pending || !ok} className={btn}>Import {ok ? state.preview!.rows.length : ""} rooms</button>
      </div>
      <div role="status" aria-live="polite">
        {state.error && <p className="rounded bg-red-50 p-2 text-sm text-red-800">{state.error}</p>}
        {state.created !== undefined && <p className="rounded bg-green-50 p-2 text-sm text-green-800">Imported {state.created} rooms from {state.fileName}.</p>}
        {state.preview && state.preview.errors.length === 0 && <p className="rounded bg-green-50 p-2 text-sm text-green-800">{state.preview.rows.length} rows are valid. Select Import to save them.</p>}
        {state.preview && state.preview.errors.length > 0 && (
          <div className="rounded bg-red-50 p-2 text-sm text-red-800">
            <p className="font-medium">{state.preview.errors.length} problem(s). Nothing was saved.</p>
            <table className="mt-2 w-full text-left text-xs">
              <thead><tr><th className="pr-3">Line</th><th>Problem</th></tr></thead>
              <tbody>{state.preview.errors.map((e, i) => <tr key={i}><td className="pr-3">{e.line}</td><td>{e.message}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </form>
  );
}
