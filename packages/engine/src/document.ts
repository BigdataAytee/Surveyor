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

const CANDIDATE_DELIMITERS = [
  { name: 'tab', pattern: /\t/g },
  { name: 'comma', pattern: /,/g },
  { name: 'semicolon', pattern: /;/g },
  { name: 'whitespace', pattern: /\s+/g },
] as const;

export type DelimiterName = (typeof CANDIDATE_DELIMITERS)[number]['name'];

function splitRow(line: string, delimiter: DelimiterName): string[] {
  const parts =
    delimiter === 'tab'
      ? line.split('\t')
      : delimiter === 'comma'
        ? line.split(',')
        : delimiter === 'semicolon'
          ? line.split(';')
          : line.trim().split(/\s+/);
  return parts.map((p) => p.trim()).filter((p, index) => p.length > 0 || index > 0);
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

    const mode = counts
      .slice()
      .sort(
        (a, b) =>
          counts.filter((c) => c === b).length - counts.filter((c) => c === a).length,
      )[0]!;
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

const NUMERIC = /^[-+]?\d+(?:[.,]\d+)?$/;

function isNumeric(value: string): boolean {
  return NUMERIC.test(value.replace(/\s/g, ''));
}

function toNumber(value: string): number {
  // A lone comma in an otherwise numeric field is a decimal separator, not a
  // thousands separator: survey coordinates are not written with grouping.
  return Number(value.replace(/\s/g, '').replace(',', '.'));
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

function roleFromHeader(header: string): ColumnRole | null {
  const cleaned = header.trim().replace(/[()[\]]/g, '');
  for (const { role, test } of HEADER_PATTERNS) {
    if (test.test(cleaned)) return role;
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
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      delimiter: 'comma',
      hasHeader: false,
      columns: [],
      rows: [],
      confidence: 0,
      warnings: ['There is nothing to read.'],
    };
  }

  const { delimiter, confidence: delimiterConfidence } = sniffDelimiter(lines);
  const allRows = lines.map((line) => splitRow(line, delimiter));
  const hasHeader = detectHeader(allRows);
  const header = hasHeader ? allRows[0] : undefined;
  const rows = hasHeader ? allRows.slice(1) : allRows;

  const warnings: string[] = [];
  const columnCount = Math.max(...allRows.map((row) => row.length));

  if (new Set(rows.map((row) => row.length)).size > 1) {
    warnings.push('Some rows have more columns than others.');
  }

  const columns = inferColumns(rows, header, columnCount, warnings);
  const confidence = Math.min(
    delimiterConfidence,
    ...columns.filter((c) => c.role !== 'unknown').map((c) => c.confidence),
  );

  return { delimiter, hasHeader, columns, rows, confidence, warnings };
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
    const candidate = columns.find(
      (c) => c.role === 'unknown' && !numericColumns.includes(c.index),
    );
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
  const freeNumeric = numericColumns.filter(
    (index) => columns[index]?.role === 'unknown',
  );

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

  const headerOffset = analysis.hasHeader ? 2 : 1;
  const seen = new Set<string>();

  analysis.rows.forEach((row, index) => {
    const line = index + headerOffset;
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

  return { analysis, points, segments: [], metadata: {}, problems };
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
