"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { toSafeError } from "@/server/errors";
import { getCtx } from "@/server/session";
import { commitImport, parseCsv, parseXlsx, previewImport, type ImportPreview } from "@/server/services/roomImport";

export type ImportState = { error?: string; preview?: ImportPreview; created?: number; fileName?: string };

const MAX_BYTES = 2 * 1024 * 1024;

export async function importRoomsAction(_prev: ImportState, fd: FormData): Promise<ImportState> {
  try {
    const ctx = await getCtx();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV or Excel file." };
    if (file.size > MAX_BYTES) return { error: "File is larger than 2 MB." };
    const name = file.name.toLowerCase();
    let grid: string[][];
    if (name.endsWith(".csv")) grid = parseCsv(await file.text());
    else if (name.endsWith(".xlsx")) grid = await parseXlsx(await file.arrayBuffer());
    else return { error: "Only .csv and .xlsx files are supported." };
    if (fd.get("mode") === "commit") {
      const r = await commitImport(getDb(), ctx, grid);
      revalidatePath("/app", "layout");
      return { created: r.created, fileName: file.name };
    }
    return { preview: await previewImport(getDb(), ctx, grid), fileName: file.name };
  } catch (e) {
    return { error: toSafeError(e).message };
  }
}
