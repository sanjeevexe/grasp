/**
 * A minimal, correct-enough RFC 4180 CSV parser, used only to validate
 * `grasp export`'s output round-trips cleanly (quoting, embedded commas/
 * quotes/newlines). Deliberately hand-rolled rather than a new dependency —
 * matches this codebase's existing "stay light on dependencies" posture
 * (see DECISIONS.md's language/stack entry and the ptyDriver.py module
 * comment for the same reasoning applied elsewhere in the test suite).
 * Handles exactly what `src/export.ts`'s `csvField`/`toCsv` actually
 * produce: `\r\n`-terminated rows, double-quote-wrapped fields whenever a
 * field contains a comma/quote/newline, embedded quotes doubled.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < content.length) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r" && content[i + 1] === "\n") {
      pushRow();
      i += 2;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // Trailing content with no final line terminator (shouldn't happen given
  // toCsv always appends a trailing \r\n, but handled defensively).
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // toCsv's trailing "\r\n" produces one real trailing empty row after the
  // last data row — drop it, matching what any real CSV reader (Python's
  // csv module included, per the prior TEST_LOG pass's own verification)
  // would report as the row count.
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  return rows;
}
