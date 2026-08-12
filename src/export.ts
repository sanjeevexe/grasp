import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { GRASP_HOME } from "./paths";
import { EventRecord } from "./types";
import { getAllEvents, getAllEventsRawRows, getConceptTagsGroupedByEvent } from "./store";

export const EXPORTS_DIR = path.join(GRASP_HOME, "exports");

/**
 * Quotes a single CSV field per RFC 4180: wrapped in double quotes (with
 * embedded double quotes doubled) whenever the value contains a comma,
 * double quote, or any newline — question/answer text routinely contains
 * all three, so this is applied unconditionally rather than trying to
 * detect "does this value need it" more cleverly.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvField).join(","));
  }
  // Trailing newline: conventional for CSV files, and avoids some tools
  // (e.g. Anki's importer) treating a missing final newline as a truncated
  // last row.
  return lines.join("\r\n") + "\r\n";
}

/** Filename-safe timestamp (colons aren't valid in filenames on some platforms) so repeated export runs never clobber each other. */
function timestampForFilename(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function conceptAnswerCell(event: EventRecord): string {
  if (event.answerConcept) return event.answerConcept;
  if (event.questionConcept && event.skipped) return "(skipped)";
  return "";
}

function instanceAnswerCell(event: EventRecord): string {
  if (event.answerInstance) return event.answerInstance;
  if (event.skipped) return "(skipped)";
  return "";
}

export type ExportShape = "default" | "anki" | "raw";

export interface ExportResult {
  filePath: string;
  rowCount: number;
  shape: ExportShape;
}

/**
 * Builds the CSV content + destination filename for one of `grasp export`'s
 * three shapes. Split out from the file-writing side (`runExport` below) so
 * tests can exercise the CSV shaping without touching the filesystem.
 */
export function buildExportCsv(db: Database.Database, shape: ExportShape, now: Date = new Date()): { csv: string; filename: string; rowCount: number } {
  const ts = timestampForFilename(now);

  if (shape === "raw") {
    const rows = getAllEventsRawRows(db);
    const header = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csv = toCsv(header, rows.map((row) => header.map((col) => row[col])));
    return { csv, filename: `grasp-export-raw-${ts}.csv`, rowCount: rows.length };
  }

  const events = getAllEvents(db);
  const tagsByEvent = getConceptTagsGroupedByEvent(db);

  if (shape === "anki") {
    // Every concept-question occurrence, answered or skipped, no dedup by
    // tag — a tag asked about more than once produces more than one row.
    // See DECISIONS.md's "grasp export --anki: no dedup by concept tag"
    // entry.
    const conceptRows = events.filter((e) => e.questionConcept !== null);
    const header = ["Front", "Back", "Tags"];
    const rows = conceptRows.map((e) => {
      const tags = (tagsByEvent.get(e.id as number) ?? []).join(" ");
      return [e.questionConcept, e.sampleAnswerConcept ?? "", tags];
    });
    return { csv: toCsv(header, rows), filename: `grasp-export-anki-${ts}.csv`, rowCount: rows.length };
  }

  // Default shape: one row per real question (question_type not null),
  // meant for the user's own spreadsheet review.
  const questionRows = events.filter((e) => e.questionType !== null);
  const header = [
    "concept_tags",
    "concept_question",
    "instance_question",
    "your_concept_answer",
    "your_instance_answer",
    "sample_concept_answer",
    "sample_instance_answer",
    "timestamp",
    "repo",
  ];
  const rows = questionRows.map((e) => {
    const tags = (tagsByEvent.get(e.id as number) ?? []).join("; ");
    return [
      tags,
      e.questionConcept ?? "",
      e.questionInstance ?? "",
      conceptAnswerCell(e),
      instanceAnswerCell(e),
      e.sampleAnswerConcept ?? "",
      e.sampleAnswerInstance ?? "",
      e.timestamp,
      e.repo,
    ];
  });
  return { csv: toCsv(header, rows), filename: `grasp-export-${ts}.csv`, rowCount: rows.length };
}

/**
 * Writes one of `grasp export`'s three CSV shapes to `~/.grasp/exports/`
 * (created if absent) and returns where it landed.
 */
export function runExportToFile(db: Database.Database, shape: ExportShape, exportsDir: string = EXPORTS_DIR): ExportResult {
  fs.mkdirSync(exportsDir, { recursive: true });
  const { csv, filename, rowCount } = buildExportCsv(db, shape);
  const filePath = path.join(exportsDir, filename);
  fs.writeFileSync(filePath, csv, "utf-8");
  return { filePath, rowCount, shape };
}

export function printExportResult(result: ExportResult): void {
  process.stdout.write(`Wrote ${result.rowCount} row(s) to ${result.filePath}\n`);
  if (result.shape === "anki") {
    process.stdout.write("Import into Anki via File > Import, choosing this CSV (Front/Back/Tags columns map automatically).\n");
  }
}
