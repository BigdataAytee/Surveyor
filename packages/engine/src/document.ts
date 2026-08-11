/**
 * Document AI — structure inference over tabular survey data (Architecture A.3).
 *
 * `parsePointTable` in input.ts is told what the columns are. This module works
 * out what they are: it sniffs the delimiter, decides whether there is a header,
 * infers what each column holds, and scores its own confidence at every step.
 *
 * The scoring is the point. A.3 routes low-confidence fields to user
 * confirmation rather than accepting them, so every inference here has to be
 * able to say how sure it is — and the places where it genuinely cannot tell
 * (easting/northing order without a header being the important one) score low
 * on purpose rather than picking the commoner convention and hoping.
 *
 * Vision/OCR extraction plugs in at the same seam: produce a `DocumentExtraction`
 * with honest per-field confidences and the rest of the pipeline is unchanged.
 */

import type { BoundarySegment, Coordinates } from '@surveyor/contracts';

import { parseBearing } from './crs.js';
import type { DocumentExtraction, ExtractedField, InputProblem } from './input.js';

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Named confidence levels, so the numbers scattered through this file mean
 * something. The validation threshold is 0.85, so anything at AMBIGUOUS or
 * below reaches the user as a confirmation prompt.
 */
export const CONFIDENCE = {
  /** Header named the column outright. */
  CERTAIN: 0.99,
  /** Unambiguous from the data alone — a text column among numbers. */
  STRONG: 0.92,
  /** Inferred from convention; a reasonable reading but not the only one. */
  AMBIGUOUS: 0.55,
  /** Something was wrong with the row and it was salvaged. */
  POOR: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Delimiter and shape
// ---------------------------------------------------------------------------

/**
 * Ordered by how specific each one is, because ties are broken by position.
 * `columns` — a run of two or more spaces — comes before `whitespace` so that a
 * table copied out of a PDF keeps `Boundary corner` as one description field
 * instead of two, while single-space-separated data still falls through to
 * `whitespace`.
 */
/**
 * Split on a single character, honouring the quoting rule every spreadsheet
 * uses when it exports. It matters here more than usual: a grouped coordinate
 * is exactly the case Excel quotes, so `PT1,"534,800.00"` is a comma-separated
 * row of two fields, and cutting it into three would corrupt the value.
 */
function splitQuoted(line: string, separator: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quoted) {
      if (character !== '"') field += character;
      else if (line[i + 1] === '"') (field += '"'), (i += 1);
      else quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (character === separator) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

/** A delimiter left dangling on a field is punctuation, not part of a value. */
function trimTrailingSeparators(fields: readonly string[]): string[] {
  return fields.map((field) => field.trim().replace(/[,;]+$/, ''));
}

const CANDIDATE_DELIMITERS = [
  { name: 'tab', split: (line: string) => splitQuoted(line, '\t') },
  {
    name: 'columns',
    split: (line: string) => trimTrailingSeparators(line.trim().split(/\s{2,}/)),
  },
  { name: 'comma', split: (line: string) => splitQuoted(line, ',') },
  { name: 'semicolon', split: (line: string) => splitQuoted(line, ';') },
  {
    name: 'whitespace',
    split: (line: string) => trimTrailingSeparators(line.trim().split(/\s+/)),
  },
] as const;

export type DelimiterName = (typeof CANDIDATE_DELIMITERS)[number]['name'];

/**
 * A cardinal letter standing on its own belongs to the number beside it.
 *
 * Field notes are written `A  E 534800.00  N 182900.00`, and splitting on
 * whitespace turns the axis labels into columns of their own. Rejoining them
 * keeps the column count honest and hands `readNumber` the letter, which is
 * what settles easting from northing without having to ask.
 */
function mergeCardinalFields(fields: readonly string[]): string[] {
  const merged: string[] = [];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    if (!/^[NSEW]$/i.test(field)) {
      merged.push(field);
      continue;
    }

    // `534800.00 E` before `E 534800.00`: both are written, but a letter that
    // follows a bare number is labelling that number, and attaching it to the
    // next one instead would move the label onto the other axis.
    const previous = merged[merged.length - 1];
    const next = fields[i + 1];
    if (previous !== undefined && readNumber(previous)?.cardinal === undefined && isNumeric(previous)) {
      merged[merged.length - 1] = `${previous}${field.toUpperCase()}`;
    } else if (next !== undefined && isNumeric(next)) {
      merged.push(`${next}${field.toUpperCase()}`);
      i += 1;
    } else {
      merged.push(field);
    }
  }

  return merged;
}

function splitRow(line: string, delimiter: DelimiterName): string[] {
  const candidate = CANDIDATE_DELIMITERS.find((d) => d.name === delimiter);
  const parts = candidate ? candidate.split(line) : line.trim().split(/\s+/);
  const trimmed = parts
    .map((p) => p.trim())
    .filter((p, index) => p.length > 0 || index > 0);
  return delimiter === 'whitespace' || delimiter === 'columns'
    ? mergeCardinalFields(trimmed)
    : trimmed;
}

/** A field that looks like a value: a number, or a plain identifier. */
const WELL_FORMED_FIELD = /^[A-Za-z0-9_.\-+ ]+$/;

function isWellFormedField(value: string): boolean {
  return value.length > 0 && (isNumeric(value) || WELL_FORMED_FIELD.test(value));
}

/**
 * Pick the delimiter that yields consistent rows of well-formed fields.
 *
 * Consistency alone is not enough to separate the two European conventions:
 * `PT1;534800,25;182900,50` splits into three fields on either a comma or a
 * semicolon, equally consistently. What distinguishes them is what the fields
 * look like afterwards — splitting on the comma leaves `PT1;534800`, which is
 * neither a number nor a name, while splitting on the semicolon leaves three
 * clean values. Cutting in the wrong place shows up in the pieces.
 *
 * Only reached when no run of coordinate rows could be found at all; when there
 * is one, `findBlock` chooses the delimiter from the run it produces.
 */
function sniffDelimiter(lines: readonly string[]): {
  delimiter: DelimiterName;
  confidence: number;
} {
  let best: { delimiter: DelimiterName; score: number } | null = null;

  for (const candidate of CANDIDATE_DELIMITERS) {
    const rows = lines.map((line) => splitRow(line, candidate.name));
    const counts = rows.map((row) => row.length);
    if (counts.some((c) => c < 2)) continue;

    const mode = modal(counts);
    const agreement = counts.filter((c) => c === mode).length / counts.length;

    const fields = rows.flat();
    const cleanliness =
      fields.length === 0
        ? 0
        : fields.filter(isWellFormedField).length / fields.length;

    // More columns is better only when the rows agree on how many there are
    // and the pieces themselves look like values.
    const score = agreement * cleanliness * (1 + Math.min(mode, 6) / 20);

    if (!best || score > best.score) {
      best = { delimiter: candidate.name, score };
    }
  }

  return best === null || best.score === 0
    ? { delimiter: 'whitespace', confidence: CONFIDENCE.POOR }
    : {
        delimiter: best.delimiter,
        confidence: Math.min(CONFIDENCE.CERTAIN, best.score),
      };
}

function modal(counts: readonly number[]): number {
  let best = 0;
  let bestFrequency = -1;
  for (const count of counts) {
    const frequency = counts.filter((c) => c === count).length;
    if (frequency > bestFrequency || (frequency === bestFrequency && count > best)) {
      best = count;
      bestFrequency = frequency;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Finding the table inside the text
// ---------------------------------------------------------------------------

/** A line of nothing but rule characters, drawn under a heading. */
const SEPARATOR_RULE = /^[\s\-_=+*|.~]+$/;

/** A row is data when it carries at least two readable numbers. */
function isDataRow(row: readonly string[]): boolean {
  return row.filter(isNumeric).length >= 2;
}

/**
 * How much of a split looks like it cut through a grouped number.
 *
 * `PT1, 534,800.00, 182,900.00` is a comma-separated row of three fields to a
 * human and of five to a splitter, and both readings are internally
 * consistent — the difference only shows in the debris. A cut inside `534,800`
 * leaves a bare one-to-three digit integer immediately followed by a field
 * that starts with exactly three digits, which is not a shape survey
 * coordinates otherwise come in.
 *
 * Scored rather than forbidden, because `5,100,200.5` is a legitimate
 * id-easting-northing row with the same signature. It only decides the outcome
 * when another delimiter reads the same text about as well.
 */
function groupingCutRatio(rows: readonly (readonly string[])[]): number {
  let cuts = 0;
  let pairs = 0;
  for (const row of rows) {
    for (let i = 0; i + 1 < row.length; i += 1) {
      pairs += 1;
      if (/^\d{1,3}$/.test(row[i] ?? '') && /^\d{3}(?:\.\d+)?$/.test(row[i + 1] ?? '')) {
        cuts += 1;
      }
    }
  }
  return pairs === 0 ? 0 : cuts / pairs;
}

interface SourceLine {
  readonly number: number;
  readonly text: string;
}

interface TableBlock {
  readonly delimiter: DelimiterName;
  readonly header: readonly string[] | undefined;
  readonly headerLine: number | undefined;
  readonly rows: readonly (readonly string[])[];
  readonly rowLines: readonly number[];
  readonly ignored: readonly SourceLine[];
  readonly confidence: number;
}

/**
 * Locate the table within whatever else was pasted.
 *
 * Real survey data does not arrive as a bare grid. It arrives under a site
 * name and a date, ruled off with dashes, and followed by a total — or as a
 * photograph of a page that had all of those on it. Treating every line as a
 * row, which is what this module used to do, meant one title line was enough
 * to make the whole paste unreadable: the delimiter sniffer saw rows that did
 * not agree on a column count, no column came out uniformly numeric, and the
 * extractor reported that it could not find any coordinates.
 *
 * So the table is found rather than assumed. For each candidate delimiter,
 * this looks for the longest consecutive run of rows that agree on a column
 * count and hold at least two numbers each, extends that run over trailing
 * rows of the same shape so a malformed one is still reported rather than
 * quietly skipped, and takes the nearest heading-like line above it. Anything
 * outside is set aside as context, not treated as an error.
 */
function findBlock(lines: readonly SourceLine[]): TableBlock | null {
  let best: (TableBlock & { score: number }) | null = null;

  for (const candidate of CANDIDATE_DELIMITERS) {
    const rows = lines.map((line) => splitRow(line.text, candidate.name));
    const dataLike = rows.map(isDataRow);
    const counts = rows.filter((_, i) => dataLike[i]).map((row) => row.length);
    if (counts.length === 0) continue;

    const width = modal(counts);
    if (width < 2) continue;

    const qualifies = rows.map(
      (row, i) => dataLike[i] === true && row.length === width,
    );

    let start = -1;
    let end = -1;
    let runStart = -1;
    for (let i = 0; i <= qualifies.length; i += 1) {
      if (qualifies[i]) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        if (i - runStart > end - start) {
          start = runStart;
          end = i;
        }
        runStart = -1;
      }
    }
    if (start === -1) continue;

    // Trailing rows of the same shape belong to the table even when they do
    // not read as data — that is how `PT2,smudged,182903` stays a reported
    // problem instead of a line that silently vanished.
    while (
      end < rows.length &&
      rows[end]?.length === width &&
      !SEPARATOR_RULE.test(lines[end]?.text ?? '')
    ) {
      end += 1;
    }

    const blockRows = rows.slice(start, end);
    const fields = blockRows.flat();
    const cleanliness =
      fields.length === 0 ? 0 : fields.filter(isWellFormedField).length / fields.length;
    const score =
      blockRows.length *
      cleanliness *
      (1 + Math.min(width, 6) / 20) *
      (1 - groupingCutRatio(blockRows));
    if (best && score <= best.score) continue;

    // The heading sits above the data, possibly with a rule between them.
    let headerIndex = -1;
    for (let i = start - 1; i >= 0; i -= 1) {
      const text = lines[i]?.text ?? '';
      if (SEPARATOR_RULE.test(text)) continue;
      const row = rows[i];
      if (row && row.length === width && !dataLike[i] && /[A-Za-z]/.test(text)) {
        headerIndex = i;
      }
      break;
    }

    const usedIndices = new Set<number>();
    for (let i = start; i < end; i += 1) usedIndices.add(i);
    if (headerIndex !== -1) usedIndices.add(headerIndex);

    best = {
      score,
      delimiter: candidate.name,
      header: headerIndex === -1 ? undefined : rows[headerIndex],
      headerLine: headerIndex === -1 ? undefined : lines[headerIndex]?.number,
      rows: blockRows,
      rowLines: lines.slice(start, end).map((line) => line.number),
      ignored: lines.filter((_, i) => !usedIndices.has(i)),
      confidence: Math.min(CONFIDENCE.CERTAIN, cleanliness),
    };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export type Cardinal = 'N' | 'S' | 'E' | 'W';

export interface NumberReading {
  readonly value: number;
  /** A cardinal letter written against the number, which names its axis. */
  readonly cardinal?: Cardinal;
  /** True when the field could equally be read as a grouped thousand. */
  readonly ambiguousGrouping: boolean;
}

/** 534800 · 534800.00 · 534800,25 — one separator, read as a decimal point. */
const PLAIN = /^\d+(?:[.,]\d+)?$/;
/** 534,800.00 · 534 800.00 · 534'800 — grouped thousands, decimal point. */
const GROUPED_POINT = /^\d{1,3}(?:[ ,']\d{3})+(?:\.\d+)?$/;
/** 534.800,00 — the European convention, grouped with dots. */
const GROUPED_COMMA = /^\d{1,3}(?:[ .']\d{3})+(?:,\d+)?$/;
/** A single comma before exactly three digits reads either way. */
const EITHER_WAY = /^\d{1,3},\d{3}$/;

/**
 * Read one numeric field.
 *
 * Stricter than it looks, and deliberately so. The previous version stripped
 * all whitespace before testing, which meant a field that had accidentally
 * swallowed a tab — `800.00\t182`, from splitting a tab-separated row on the
 * comma inside `534,800.00` — passed as the number 800.00182 and became a
 * coordinate. Silent corruption of a survey value is the worst failure this
 * module can have, so nothing with whitespace inside it is a number now;
 * grouping separators have to be written out in the grammar to be accepted.
 */
export function readNumber(raw: string): NumberReading | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const signed = /^([-+])(.*)$/.exec(trimmed);
  const sign = signed?.[1] === '-' ? -1 : 1;
  let body = signed?.[2] ?? trimmed;

  // A cardinal letter labels the axis rather than the value: `534800.00E`.
  // Only at coordinate magnitude, so a station called `N1` stays a name.
  let cardinal: Cardinal | undefined;
  const marked = /^([NSEW])(.+)$/i.exec(body) ?? /^(.+?)([NSEW])$/i.exec(body);
  if (marked) {
    const letter = (/^[NSEW]$/i.test(marked[1] ?? '') ? marked[1] : marked[2]) ?? '';
    const rest = (/^[NSEW]$/i.test(marked[1] ?? '') ? marked[2] : marked[1]) ?? '';
    const digits = rest.replace(/\D/g, '');
    if (/[.,]/.test(rest) || digits.length >= 4) {
      cardinal = letter.toUpperCase() as Cardinal;
      body = rest.trim();
    }
  }

  const reading = (value: number): NumberReading => ({
    value: sign * value,
    ...(cardinal === undefined ? {} : { cardinal }),
    ambiguousGrouping: EITHER_WAY.test(body),
  });

  // Plain first: `534.800` is a metre-and-millimetres reading far more often
  // than it is a grouped thousand.
  if (PLAIN.test(body)) return reading(Number(body.replace(',', '.')));
  if (GROUPED_POINT.test(body)) return reading(Number(body.replace(/[ ,']/g, '')));
  if (GROUPED_COMMA.test(body)) {
    return reading(Number(body.replace(/[ .']/g, '').replace(',', '.')));
  }
  return null;
}

function isNumeric(value: string): boolean {
  return readNumber(value) !== null;
}

function toNumber(value: string): number {
  return readNumber(value)?.value ?? Number.NaN;
}

// ---------------------------------------------------------------------------
// Column roles
// ---------------------------------------------------------------------------

export type ColumnRole =
  | 'id'
  | 'easting'
  | 'northing'
  | 'elevation'
  | 'description'
  | 'unknown';

export interface ColumnAnalysis {
  readonly index: number;
  readonly role: ColumnRole;
  readonly confidence: number;
  readonly header?: string;
}

const HEADER_PATTERNS: readonly { readonly role: ColumnRole; readonly test: RegExp }[] = [
  { role: 'id', test: /^(pt|point|id|name|no\.?|num|station|stn|mark)$/i },
  { role: 'easting', test: /^(e|east|easting|x|x[-_ ]?coord)$/i },
  { role: 'northing', test: /^(n|north|northing|y|y[-_ ]?coord)$/i },
  { role: 'elevation', test: /^(z|elev|elevation|height|ht|rl|level)$/i },
  { role: 'description', test: /^(desc|description|code|note|notes|remark|remarks|feature)$/i },
];

/**
 * Words that qualify a heading without changing what it means, so that
 * `Pt No`, `Easting (m)` and `Northing_m` all reach the same role as the bare
 * word. Headings printed in a column layout routinely carry one.
 */
const HEADER_NOISE = /\b(no|num|number|name|id|ref|m|metres?|meters?|ft|feet|coord|coords|coordinate|value)\b/gi;

function roleFromHeader(header: string): ColumnRole | null {
  const cleaned = header.trim().replace(/[()[\]{}.:]/g, ' ').replace(/[_/]/g, ' ');

  for (const { role, test } of HEADER_PATTERNS) {
    if (test.test(cleaned.trim())) return role;
  }

  // `Easting (m)` and `Pt No` only differ from `Easting` and `Pt` by a word
  // that carries no meaning of its own. Strip those and try once more, but
  // never down to nothing — an empty heading must not match anything.
  const stripped = cleaned.replace(HEADER_NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (stripped.length === 0 || stripped === cleaned.trim()) return null;

  for (const { role, test } of HEADER_PATTERNS) {
    if (test.test(stripped)) return role;
  }
  return null;
}

/**
 * A first row is a header when it is non-numeric where the body is numeric.
 * "PT1, 534800, 182900" has no header; "Point, Easting, Northing" does.
 */
function detectHeader(rows: readonly string[][]): boolean {
  const [first, ...body] = rows;
  if (!first || body.length === 0) return false;

  const bodyNumericColumns = first.map((_, column) =>
    body.every((row) => {
      const cell = row[column];
      return cell !== undefined && isNumeric(cell);
    }),
  );

  return bodyNumericColumns.some(
    (numeric, column) => numeric && !isNumeric(first[column] ?? ''),
  );
}

export interface TableAnalysis {
  readonly delimiter: DelimiterName;
  readonly hasHeader: boolean;
  readonly columns: readonly ColumnAnalysis[];
  readonly rows: readonly (readonly string[])[];
  /** Source line number of each row, so problems point at the right line. */
  readonly rowLines: readonly number[];
  /** Lines outside the table — a title, a total, a rule. Context, not error. */
  readonly ignored: readonly { readonly line: number; readonly text: string }[];
  /** Lowest confidence among the decisions taken. */
  readonly confidence: number;
  readonly warnings: readonly string[];
}

/**
 * Work out the shape of a pasted or uploaded table.
 *
 * Exported separately from extraction so the UI can show what was detected and
 * let the user correct it before any of it becomes survey data.
 */
export function analyzeTable(text: string): TableAnalysis {
  const lines: SourceLine[] = text
    .split(/\r?\n/)
    .map((line, index) => ({ number: index + 1, text: line.trim() }))
    .filter((line) => line.text.length > 0);

  if (lines.length === 0) {
    return {
      delimiter: 'comma',
      hasHeader: false,
      columns: [],
      rows: [],
      rowLines: [],
      ignored: [],
      confidence: 0,
      warnings: ['There is nothing to read.'],
    };
  }

  const block = findBlock(lines);
  const warnings: string[] = [];

  // No run of coordinate rows anywhere: fall back to reading the whole paste as
  // one table so that whatever is wrong with it is described in the same terms.
  const texts = lines.map((line) => line.text);
  const delimiter = block?.delimiter ?? sniffDelimiter(texts).delimiter;
  const allRows = block ? null : texts.map((line) => splitRow(line, delimiter));
  const hasHeader = block ? block.header !== undefined : detectHeader(allRows ?? []);
  const header = block ? block.header : hasHeader ? allRows?.[0] : undefined;
  const rows = block ? block.rows : hasHeader ? (allRows ?? []).slice(1) : (allRows ?? []);
  const rowLines = block
    ? block.rowLines
    : lines.slice(hasHeader ? 1 : 0).map((line) => line.number);

  if (block && block.ignored.length > 0) {
    warnings.push(
      block.ignored.length === 1
        ? `I skipped one line that is not part of the table: "${block.ignored[0]?.text}".`
        : `I skipped ${block.ignored.length} lines that are not part of the table.`,
    );
  }

  const columnCount = Math.max(...[...rows, header ?? []].map((row) => row.length), 0);

  if (new Set(rows.map((row) => row.length)).size > 1) {
    warnings.push('Some rows have more columns than others.');
  }

  const columns = inferColumns(rows, header, columnCount, warnings);
  const named = columns.filter((c) => c.role !== 'unknown');
  const confidence = Math.min(
    block?.confidence ?? sniffDelimiter(texts).confidence,
    ...(named.length === 0 ? [0] : named.map((c) => c.confidence)),
  );

  return {
    delimiter,
    hasHeader,
    columns,
    rows,
    rowLines,
    ignored: block ? block.ignored.map((l) => ({ line: l.number, text: l.text })) : [],
    confidence,
    warnings,
  };
}

function inferColumns(
  rows: readonly (readonly string[])[],
  header: readonly string[] | undefined,
  columnCount: number,
  warnings: string[],
): readonly ColumnAnalysis[] {
  const columns: ColumnAnalysis[] = [];
  const claimed = new Set<ColumnRole>();

  // --- Named columns win outright ----------------------------------------
  for (let index = 0; index < columnCount; index += 1) {
    const name = header?.[index];
    const role = name ? roleFromHeader(name) : null;

    if (role && !claimed.has(role)) {
      claimed.add(role);
      columns.push({
        index,
        role,
        confidence: CONFIDENCE.CERTAIN,
        ...(name === undefined ? {} : { header: name }),
      });
    } else {
      columns.push({
        index,
        role: 'unknown',
        confidence: 0,
        ...(name === undefined ? {} : { header: name }),
      });
    }
  }

  const numericColumns: number[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    const values = rows.map((row) => row[index]).filter((v): v is string => v !== undefined);
    if (values.length > 0 && values.every(isNumeric)) numericColumns.push(index);
  }

  // --- The id column: text where the rest is numeric ----------------------
  if (!claimed.has('id')) {
    const textColumns = columns.filter(
      (c) => c.role === 'unknown' && !numericColumns.includes(c.index),
    );
    // A column holding the same word on every row is a label, not a name.
    // `corner A / corner B / corner C` identifies points by the second column.
    const distinct = textColumns.find((c) => {
      const values = rows.map((row) => row[c.index] ?? '');
      return values.length > 1 && new Set(values).size === values.length;
    });
    const candidate = distinct ?? textColumns[0];
    if (candidate) {
      claimed.add('id');
      columns[candidate.index] = {
        ...candidate,
        role: 'id',
        confidence: CONFIDENCE.STRONG,
      };
    }
  }

  // --- The coordinate pair ------------------------------------------------
  let freeNumeric = numericColumns.filter(
    (index) => columns[index]?.role === 'unknown',
  );

  // A cardinal letter written against the value — `534800.00E` — names the
  // axis outright, which settles the one question this module otherwise has to
  // ask the user. Worth checking before falling back to convention.
  for (const index of freeNumeric) {
    const readings = rows
      .map((row) => row[index])
      .filter((v): v is string => v !== undefined)
      .map(readNumber);
    const cardinals = new Set(
      readings.map((r) => r?.cardinal).filter((c): c is Cardinal => c !== undefined),
    );
    if (cardinals.size !== 1 || readings.some((r) => r?.cardinal === undefined)) continue;

    const role: ColumnRole = cardinals.has('E') || cardinals.has('W') ? 'easting' : 'northing';
    if (claimed.has(role)) continue;
    claimed.add(role);
    columns[index] = { ...columns[index]!, role, confidence: CONFIDENCE.CERTAIN };
  }

  // A field like `534,800` reads as a grouped thousand or as millimetres, and
  // the difference is a factor of a thousand. Nothing in the text settles it.
  const ambiguous = rows
    .flat()
    .some((value) => readNumber(value)?.ambiguousGrouping === true);
  if (ambiguous) {
    warnings.push(
      'Some numbers are written like 534,800 — I read the comma as a decimal ' +
        'point. If it separates thousands, these coordinates are a thousand ' +
        'times too small.',
    );
  }

  freeNumeric = numericColumns.filter((index) => columns[index]?.role === 'unknown');

  if (!claimed.has('easting') && !claimed.has('northing') && freeNumeric.length >= 2) {
    const [a, b] = freeNumeric as [number, number];
    // Without a header there is no way to tell an easting from a northing:
    // both are large positive numbers of similar magnitude. Assuming the
    // commoner order and moving on would silently mirror the whole site, so
    // this scores low and the UI asks.
    columns[a] = { ...columns[a]!, role: 'easting', confidence: CONFIDENCE.AMBIGUOUS };
    columns[b] = { ...columns[b]!, role: 'northing', confidence: CONFIDENCE.AMBIGUOUS };
    claimed.add('easting');
    claimed.add('northing');
    warnings.push(
      'No column headings, so I assumed easting comes before northing. ' +
        'Check that before using these points.',
    );
  } else {
    // One of the pair was named; the other is the remaining numeric column.
    for (const missing of ['easting', 'northing'] as const) {
      if (claimed.has(missing)) continue;
      const candidate = freeNumeric.find((index) => columns[index]?.role === 'unknown');
      if (candidate === undefined) continue;
      claimed.add(missing);
      columns[candidate] = {
        ...columns[candidate]!,
        role: missing,
        confidence: CONFIDENCE.STRONG,
      };
    }
  }

  // --- Whatever is left ---------------------------------------------------
  if (!claimed.has('elevation')) {
    const candidate = freeNumeric.find((index) => columns[index]?.role === 'unknown');
    if (candidate !== undefined) {
      columns[candidate] = {
        ...columns[candidate]!,
        role: 'elevation',
        confidence: CONFIDENCE.AMBIGUOUS,
      };
    }
  }
  for (const column of columns) {
    if (column.role === 'unknown' && !numericColumns.includes(column.index)) {
      columns[column.index] = {
        ...column,
        role: 'description',
        confidence: CONFIDENCE.STRONG,
      };
    }
  }

  if (!claimed.has('easting') || !claimed.has('northing')) {
    warnings.push('I could not find two coordinate columns.');
  }

  return columns;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Overrides the inferred coordinate order once the user has confirmed it. */
  readonly swapEastingNorthing?: boolean;
}

export interface PointExtraction extends DocumentExtraction {
  readonly analysis: TableAnalysis;
  readonly problems: readonly InputProblem[];
}

/**
 * Does this text look like survey data rather than something someone typed?
 *
 * Used to decide whether a message is a question or a paste of data, so it has
 * to be cheap and it has to be shy: a sentence with a couple of numbers in it
 * is a question, and treating it as a table would be worse than missing a
 * paste. Three lines each carrying two numbers is not something a person types
 * into a chat box by accident.
 */
export function looksLikeSurveyData(text: string): boolean {
  const dataLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SEPARATOR_RULE.test(line))
    .filter(
      (line) =>
        mergeCardinalFields(line.split(/[\s,;]+/).filter((t) => t.length > 0)).filter(
          isNumeric,
        ).length >= 2,
    );

  return dataLines.length >= 3;
}

/**
 * Read points line by line, without a column model.
 *
 * The table reader needs the rows to agree on a shape. A page of field notes
 * does not oblige — one corner carries a remark and the next does not, so the
 * rows are ragged and the block reader can only trust the widest run of them.
 * This gives up on structure entirely and reads each line on its own terms: a
 * name, then the first two numbers big enough to be coordinates.
 *
 * Weaker than the table path and scored accordingly, so it is only reached
 * when the table path came back with too little to draw.
 */
function scanPointLines(text: string): {
  readonly points: readonly ExtractedField<{ id: string; coordinates: Coordinates }>[];
  readonly problems: readonly InputProblem[];
} {
  const points: ExtractedField<{ id: string; coordinates: Coordinates }>[] = [];
  const problems: InputProblem[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || SEPARATOR_RULE.test(line)) return;

    const tokens = mergeCardinalFields(line.split(/[\s,;]+/).filter((t) => t.length > 0));
    const numbers = tokens
      .map((token, position) => ({ position, reading: readNumber(token) }))
      .filter((entry): entry is { position: number; reading: NumberReading } =>
        entry.reading !== null,
      );

    if (numbers.length < 2) return;

    // Two readings with opposite axis letters name themselves; otherwise take
    // the first two numbers in the order they were written.
    const east = numbers.find((n) => n.reading.cardinal === 'E' || n.reading.cardinal === 'W');
    const north = numbers.find((n) => n.reading.cardinal === 'N' || n.reading.cardinal === 'S');
    const easting = east ?? numbers[0]!;
    const northing = north ?? numbers.find((n) => n !== easting);
    if (!northing || northing === easting) return;

    // The name sits closest to the values it labels — `corner A = 534800.00 E`
    // is point A, not point "corner" — so this reads back from the numbers
    // rather than forward from the start of the line.
    const nameToken = tokens
      .slice(0, Math.min(easting.position, northing.position))
      .filter((token) => readNumber(token) === null && /[A-Za-z0-9]/.test(token))
      .pop();

    let id = nameToken ?? `PT${points.length + 1}`;
    if (seen.has(id)) {
      problems.push({
        line: index + 1,
        text: line,
        message: `There is already a point called ${id}; read as ${id}_${points.length + 1}.`,
      });
      id = `${id}_${points.length + 1}`;
    }
    seen.add(id);

    points.push({
      value: {
        id,
        coordinates: {
          easting: easting.reading.value,
          northing: northing.reading.value,
        },
      },
      // Nothing here names the axes unless the note itself did, so without
      // cardinal letters this stays below the threshold and reaches the user.
      confidence: east && north ? CONFIDENCE.STRONG : CONFIDENCE.AMBIGUOUS,
    });
  });

  return { points, problems };
}

/**
 * Read survey points out of a table, carrying a confidence for every one.
 *
 * A row that cannot be read becomes a reported problem with its original text,
 * never a skipped line and never a zero coordinate.
 */
export function extractPoints(
  text: string,
  options: ExtractOptions = {},
): PointExtraction {
  const analysis = analyzeTable(text);
  const problems: InputProblem[] = [];
  const points: ExtractedField<{ id: string; coordinates: Coordinates }>[] = [];

  const column = (role: ColumnRole): ColumnAnalysis | undefined =>
    analysis.columns.find((c) => c.role === role);

  const idColumn = column('id');
  let eastingColumn = column('easting');
  let northingColumn = column('northing');
  const elevationColumn = column('elevation');

  if (options.swapEastingNorthing) {
    [eastingColumn, northingColumn] = [northingColumn, eastingColumn];
  }

  if (!eastingColumn || !northingColumn) {
    const scanned = scanPointLines(text);
    if (scanned.points.length >= 3) return withScan(analysis, scanned, options);

    return {
      analysis,
      points: [],
      segments: [],
      metadata: {},
      problems: [
        {
          line: 0,
          text: '',
          message:
            'I could not find an easting and a northing column, so there are ' +
            'no points to read.',
        },
      ],
    };
  }

  const seen = new Set<string>();

  analysis.rows.forEach((row, index) => {
    // The true source line, so a problem points at the line the user is
    // looking at rather than at an offset into the table.
    const line = analysis.rowLines[index] ?? index + 1;
    const eastingText = row[eastingColumn.index];
    const northingText = row[northingColumn.index];

    if (
      eastingText === undefined ||
      northingText === undefined ||
      !isNumeric(eastingText) ||
      !isNumeric(northingText)
    ) {
      problems.push({
        line,
        text: row.join(' '),
        message: 'This row does not have two readable coordinates.',
      });
      return;
    }

    const rawId = idColumn ? row[idColumn.index] : undefined;
    let id = rawId && rawId.length > 0 ? rawId : `PT${index + 1}`;
    let confidence = Math.min(
      eastingColumn.confidence,
      northingColumn.confidence,
      idColumn?.confidence ?? CONFIDENCE.AMBIGUOUS,
    );

    if (!rawId || rawId.length === 0) {
      // A generated name is a guess about identity, and it should say so.
      confidence = Math.min(confidence, CONFIDENCE.AMBIGUOUS);
    }

    if (seen.has(id)) {
      const unique = `${id}_${index + 1}`;
      problems.push({
        line,
        text: row.join(' '),
        message: `There is already a point called ${id}; read as ${unique}.`,
      });
      id = unique;
      confidence = Math.min(confidence, CONFIDENCE.POOR);
    }
    seen.add(id);

    const elevationText = elevationColumn ? row[elevationColumn.index] : undefined;
    const elevation =
      elevationText !== undefined && isNumeric(elevationText)
        ? toNumber(elevationText)
        : undefined;

    points.push({
      value: {
        id,
        coordinates: {
          easting: toNumber(eastingText),
          northing: toNumber(northingText),
          ...(elevation === undefined ? {} : { elevation }),
        },
      },
      confidence,
    });
  });

  // The table reader trusts its column model, which means a page of ragged
  // field notes can leave it holding only the widest run of matching rows.
  // Reading line by line has no column model to lose, so when it finds more
  // than the columns did, it found the note the columns could not see.
  const scanned = scanPointLines(text);
  if (scanned.points.length > points.length && scanned.points.length >= 3) {
    return withScan(analysis, scanned, options);
  }

  return { analysis, points, segments: [], metadata: {}, problems };
}

/** Present a line-by-line scan as an extraction, honouring a confirmed order. */
function withScan(
  analysis: TableAnalysis,
  scanned: ReturnType<typeof scanPointLines>,
  options: ExtractOptions,
): PointExtraction {
  const points = options.swapEastingNorthing
    ? scanned.points.map((point) => ({
        ...point,
        value: {
          ...point.value,
          coordinates: {
            ...point.value.coordinates,
            easting: point.value.coordinates.northing,
            northing: point.value.coordinates.easting,
          },
        },
      }))
    : scanned.points;

  return {
    analysis: {
      ...analysis,
      warnings: [
        ...analysis.warnings,
        'This is not laid out as a table, so I read each line on its own. ' +
          'Check the points before using them.',
      ],
    },
    points,
    segments: [],
    metadata: {},
    problems: scanned.problems,
  };
}

/**
 * Read a bearing-and-distance traverse out of free text.
 *
 * Tolerates prose around the values — deed descriptions are written as
 * sentences — by pulling the first bearing and the last number from each line.
 */
export function extractTraverse(text: string): {
  readonly segments: readonly ExtractedField<BoundarySegment>[];
  readonly problems: readonly InputProblem[];
} {
  const segments: ExtractedField<BoundarySegment>[] = [];
  const problems: InputProblem[] = [];

  const BEARING = /([NS]\s*\d+(?:[°d ]\s*\d+)?(?:['m ]\s*\d+(?:\.\d+)?)?\s*["s]?\s*[EW])/i;
  const DISTANCE = /(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?|ft|feet)?\s*$/i;

  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line, index) => {
      const bearingMatch = BEARING.exec(line);
      const distanceMatch = DISTANCE.exec(line);

      if (!bearingMatch || !distanceMatch) {
        problems.push({
          line: index + 1,
          text: line,
          message: 'I could not find both a bearing and a distance on this line.',
        });
        return;
      }

      const bearing = parseBearing(bearingMatch[1]!.replace(/\s+/g, ' '));
      if (bearing === null) {
        problems.push({
          line: index + 1,
          text: line,
          message: `I could not read "${bearingMatch[1]}" as a bearing.`,
        });
        return;
      }

      // Point names, when the line starts with a pair of them.
      const names = /^([A-Za-z]\w*)\s+([A-Za-z]\w*)\b/.exec(line);
      const from = names?.[1] ?? `PT${index + 1}`;
      const to = names?.[2] ?? `PT${index + 2}`;

      segments.push({
        value: {
          from,
          to,
          bearing,
          distance: Number(distanceMatch[1]),
          provenance: { source: 'measured' },
        },
        // Names inferred from position are a weaker reading than named columns.
        confidence: names ? CONFIDENCE.STRONG : CONFIDENCE.AMBIGUOUS,
      });
    });

  return { segments, problems };
}
