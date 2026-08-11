import { NextRequest, NextResponse } from "next/server";
import { parseLoanCount } from "@/lib/parse-loan-count";
import { runLoanNumberCompletion } from "@/lib/loan-number-completion";
import { createServerClient } from "@/lib/supabase-server";
import type { UploadLoanCountResponse } from "@/types";
import { requireSession } from "@/lib/auth";

type ExistingRow = Record<string, unknown> & {
  id: string;
  loan_number: string;
  manually_edited_fields: string[] | null;
};

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const force = searchParams.get("force") === "true";

    const buffer = Buffer.from(await file.arrayBuffer());
    const { rows, warnings } = parseLoanCount(buffer);

    if (rows.length === 0) {
      return NextResponse.json({ error: "No valid loan rows found in file" }, { status: 422 });
    }

    const month = rows[0].month ?? null;
    const year = rows[0].year ?? null;

    // Fail fast if the file has no recognizable Month/Year columns — prevents
    // silent bypass of the duplicate check and deduplication merge.
    if (!month || year == null) {
      return NextResponse.json(
        {
          error:
            "Could not determine month/year from the file. " +
            "Expected column headers 'Month' and 'Year' (case-insensitive). " +
            `Got month=${JSON.stringify(month)}, year=${JSON.stringify(year)}.`,
        },
        { status: 422 }
      );
    }

    // ── Duplicate check ───────────────────────────────────────────────────────
    if (!force && month && year) {
      const { count } = await supabase
        .from("loan_officials")
        .select("id", { count: "exact", head: true })
        .eq("month", month)
        .eq("year", year);

      if (count && count > 0) {
        return NextResponse.json(
          { duplicate: true, info: { month, year, existing_count: count } },
          { status: 409 }
        );
      }
    }

    // ── Load existing rows for merge ──────────────────────────────────────────
    const { data: existingData, error: fetchErr } = await supabase
      .from("loan_officials")
      .select("*")
      .eq("month", month ?? "")
      .eq("year", year ?? 0);

    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

    const existingMap = new Map<string, ExistingRow>();
    for (const row of (existingData ?? []) as ExistingRow[]) {
      existingMap.set(row.loan_number, row);
    }

    const newLoanNumbers = new Set(rows.map((r) => r.loan_number));

    // ── Merge: new rows vs existing rows ──────────────────────────────────────
    type MergedRow = typeof rows[number] & { id?: string };

    // Track which existing ids to keep so we can delete everything else
    // (including any orphan duplicates that slipped in from previous buggy uploads)
    const keptIds = new Set<string>();
    let keptHistorical = 0;

    // Rows not in the new file: keep if manually edited, otherwise mark for deletion
    for (const [ln, row] of existingMap) {
      if (!newLoanNumbers.has(ln)) {
        const hasManualEdits = (row.manually_edited_fields ?? []).length > 0;
        if (hasManualEdits) {
          keptHistorical++;
          keptIds.add(row.id);
        }
      }
    }

    const toInsert: typeof rows = [];
    const toUpsert: MergedRow[] = [];
    let preservedFields = 0;

    for (const newRow of rows) {
      const existing = existingMap.get(newRow.loan_number);
      if (!existing) {
        toInsert.push({ ...newRow, manually_edited_fields: [] });
      } else {
        const editedFields: string[] = (existing.manually_edited_fields as string[]) ?? [];
        const merged: Record<string, unknown> = {
          ...newRow,
          manually_edited_fields: editedFields,
          id: existing.id,
        };
        // Restore manually edited values, overriding what the file says
        for (const field of editedFields) {
          if (field in existing) {
            merged[field] = existing[field];
          }
        }
        preservedFields += editedFields.length;
        keptIds.add(existing.id);
        toUpsert.push(merged as MergedRow);
      }
    }

    // Delete any existing row for this period not being kept — includes rows
    // not in the new file AND any orphan duplicates (same loan_number, multiple rows)
    const toDeleteIds = (existingData ?? [])
      .map((r) => (r as ExistingRow).id)
      .filter((id) => !keptIds.has(id));

    if (toDeleteIds.length > 0) {
      await supabase.from("loan_officials").delete().in("id", toDeleteIds);
    }

    // ── Insert new loan numbers ───────────────────────────────────────────────
    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const { error } = await supabase.from("loan_officials").insert(toInsert.slice(i, i + CHUNK));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ── Upsert merged rows (preserves manual edits) ───────────────────────────
    for (let i = 0; i < toUpsert.length; i += CHUNK) {
      const { error } = await supabase.from("loan_officials").upsert(
        toUpsert.slice(i, i + CHUNK).map((r) => ({
          ...r,
          updated_at: new Date().toISOString(),
        }))
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ── Loan number completion ────────────────────────────────────────────────
    const completion = await runLoanNumberCompletion(supabase);

    const response: UploadLoanCountResponse = {
      rowCount: rows.length,
      month,
      year,
      warnings: warnings.length,
      merge: {
        inserted: toInsert.length,
        updated: toUpsert.length,
        preserved_fields: preservedFields,
        removed: toDeleteIds.length,
        kept_historical: keptHistorical,
      },
      completion,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[upload-loan-count]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
