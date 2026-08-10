/**
 * Input Engine (Architecture A.3).
 *
 * Normalizes structured entry (typed coordinates, pasted tables) and the output
 * of unstructured extraction into the Survey Data Model.
 *
 * The rule that shapes every parser here: "Missing/ambiguous fields are flagged
 * to the user, never guessed." A line that does not parse becomes a reported
 * problem with its original text attached, not a skipped row and not a zero.
 */

import type {
  BoundaryRing,
  BoundarySegment,
  Coordinates,
  Provenance,
  SurveyDataModel,
  SurveyPoint,
} from '@surveyor/contracts';

import { parseBearing } from './crs.js';

export interface InputProblem {
  /** 1-based line number in the pasted text. */
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

export interface ParseResult<T> {
  readonly parsed: readonly T[];
  readonly problems: readonly InputProblem[];
}

const SEPARATORS = /[\t,;]+|\s{2,}|\s+/;

function splitFields(line: string): string[] {
  return line.trim().split(SEPARATORS).filter((f) => f.length > 0);
}

function isNumeric(value: string): boolean {
  return /^[-+]?\d+(?:\.\d+)?$/.test(value);
}

// ---------------------------------------------------------------------------
// Coordinate tables
// ---------------------------------------------------------------------------

export interface PointTableOptions {
  /** Provenance applied to every point parsed. Defaults to measured. */
  readonly provenance?: Provenance;
  /**
   * Column order. Surveyors write both, and getting it wrong silently mirrors
   * the whole site, so it is an explicit choice rather than a sniffed one.
   */
  readonly order?: 'id-easting-northing' | 'id-northing-easting';
}

/**
 * Parse a pasted point table.
 *
 * Accepts comma, tab, or whitespace separation, an optional header row, and an
 * optional trailing description column:
 *
 *   PT1, 534821.42, 182934.18
 *   PT2  534902.57  182915.33  fence corner
 */
export function parsePointTable(
  text: string,
  options: PointTableOptions = {},
): ParseResult<SurveyPoint> {
  const provenance = options.provenance ?? { source: 'measured' as const };
  const eastingFirst = (options.order ?? 'id-easting-northing') === 'id-easting-northing';

  const parsed: SurveyPoint[] = [];
  const problems: InputProblem[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim().length === 0) return;

    const fields = splitFields(raw);
    if (fields.length < 3) {
      // A header row is the common benign case; anything else is a real problem.
      if (fields.length > 0 && !fields.some(isNumeric) && index === 0) return;
      problems.push({
        line,
        text: raw,
        message: 'Expected a point name followed by two coordinates.',
      });
      return;
    }

    const [id, first, second, ...rest] = fields as [string, string, string, ...string[]];
    if (!isNumeric(first) || !isNumeric(second)) {
      if (index === 0) return; // header
      problems.push({
        line,
        text: raw,
        message: `"${first}" and "${second}" are not both numbers.`,
      });
      return;
    }

    if (seen.has(id)) {
      problems.push({
        line,
        text: raw,
        message: `There is already a point called ${id}.`,
      });
      return;
    }
    seen.add(id);

    const coordinates: Coordinates = eastingFirst
      ? { easting: Number(first), northing: Number(second) }
      : { easting: Number(second), northing: Number(first) };

    const description = rest.join(' ').trim();
    parsed.push({
      id,
      coordinates,
      provenance,
      ...(description.length > 0 ? { description } : {}),
    });
  });

  return { parsed, problems };
}

// ---------------------------------------------------------------------------
// Traverse text
// ---------------------------------------------------------------------------

/**
 * Parse a deed-style traverse:
 *
 *   PT1 PT2 N 87°14'32" E 81.42
 *   PT2 PT3 S 02°45'28" E 24.10
 *
 * The bearing may be quadrant or azimuth; the distance is the last field.
 */
export function parseTraverse(
  text: string,
  provenance: Provenance = { source: 'measured' },
): ParseResult<BoundarySegment> {
  const parsed: BoundarySegment[] = [];
  const problems: InputProblem[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim().length === 0) return;

    const fields = splitFields(raw);
    if (fields.length < 4) {
      problems.push({
        line,
        text: raw,
        message: 'Expected two point names, a bearing, and a distance.',
      });
      return;
    }

    const from = fields[0]!;
    const to = fields[1]!;
    const distanceText = fields[fields.length - 1]!;
    const bearingText = fields.slice(2, -1).join(' ');

    if (!isNumeric(distanceText)) {
      problems.push({
        line,
        text: raw,
        message: `"${distanceText}" is not a distance.`,
      });
      return;
    }

    const bearing = parseBearing(bearingText);
    if (bearing === null) {
      problems.push({
        line,
        text: raw,
        message: `I could not read "${bearingText}" as a bearing.`,
      });
      return;
    }

    parsed.push({
      from,
      to,
      bearing,
      distance: Number(distanceText),
      provenance,
    });
  });

  return { parsed, problems };
}

/** Build a closed ring from parsed segments, in the order they were given. */
export function ringFromSegments(
  id: string,
  segments: readonly BoundarySegment[],
): BoundaryRing {
  return {
    id,
    segments,
    closed:
      segments.length > 2 &&
      segments[0]!.from === segments[segments.length - 1]!.to,
  };
}

/** Build a ring by walking a list of point ids in order and closing the loop. */
export function ringFromPointOrder(
  id: string,
  pointIds: readonly string[],
  provenance: Provenance = { source: 'measured' },
): BoundaryRing {
  const segments: BoundarySegment[] = [];
  for (let i = 0; i < pointIds.length; i += 1) {
    segments.push({
      from: pointIds[i]!,
      to: pointIds[(i + 1) % pointIds.length]!,
      provenance,
    });
  }
  return { id, segments, closed: true };
}

// ---------------------------------------------------------------------------
// Document extraction boundary
// ---------------------------------------------------------------------------

/**
 * What an OCR/vision extractor hands back. Defining it here lets Document AI be
 * built in parallel (A.4 step 7) and keeps confidence in the pipeline: an
 * extracted field arrives with a score, and low scores become confirmation
 * prompts rather than silent data.
 */
export interface ExtractedField<T> {
  readonly value: T;
  /** 0-1. Anything below the validation threshold prompts the user. */
  readonly confidence: number;
  /** Where on the page it was read from, for the confirmation UI. */
  readonly sourceRegion?: {
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface DocumentExtraction {
  readonly points: readonly ExtractedField<{
    readonly id: string;
    readonly coordinates: Coordinates;
  }>[];
  readonly segments: readonly ExtractedField<BoundarySegment>[];
  readonly metadata: Readonly<Record<string, ExtractedField<string>>>;
}

/**
 * Fold an extraction into survey points, carrying each field's confidence into
 * its provenance so the Validation Engine can raise the low ones.
 */
export function pointsFromExtraction(
  extraction: DocumentExtraction,
): readonly SurveyPoint[] {
  return extraction.points.map((field) => ({
    id: field.value.id,
    coordinates: field.value.coordinates,
    provenance: { source: 'measured' as const, confidence: field.confidence },
  }));
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

export interface ModelDraft {
  readonly metadata: SurveyDataModel['metadata'];
  readonly crs: SurveyDataModel['crs'];
  readonly points?: readonly SurveyPoint[];
  readonly boundary?: readonly BoundaryRing[];
  readonly siteFeatures?: SurveyDataModel['siteFeatures'];
  readonly notes?: SurveyDataModel['notes'];
}

export function buildModel(draft: ModelDraft): SurveyDataModel {
  return {
    metadata: draft.metadata,
    crs: draft.crs,
    points: draft.points ?? [],
    boundary: draft.boundary ?? [],
    siteFeatures: draft.siteFeatures ?? [],
    notes: draft.notes ?? [],
  };
}

/** Point ids referenced by a ring that do not exist yet. */
export function missingPointIds(
  model: SurveyDataModel,
): readonly string[] {
  const known = new Set(model.points.map((p) => p.id));
  const missing = new Set<string>();

  for (const ring of model.boundary) {
    for (const segment of ring.segments) {
      // A ring given as bearings and distances legitimately names points that
      // have no coordinates yet — COGO computes them. Only the very first
      // point must exist for the traverse to have somewhere to start.
      if (!known.has(segment.from) && segment === ring.segments[0]) {
        missing.add(segment.from);
      }
      if (
        !known.has(segment.to) &&
        (segment.bearing === undefined || segment.distance === undefined)
      ) {
        missing.add(segment.to);
      }
    }
  }
  return [...missing];
}
