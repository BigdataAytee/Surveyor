/**
 * Reading DXF.
 *
 * The exporter writes ASCII DXF R12, and until now nothing could read one
 * back — which made the export a one-way door. A surveyor who sent a drawing
 * to a colleague could not take their corrections back, and a firm with an
 * existing library of DXFs could not start from any of them.
 *
 * This reads the entity section and nothing else. DXF is a large format and
 * most of it is about how a drawing looks; what a survey needs from it is
 * where things are. POINT, LINE, LWPOLYLINE, POLYLINE, CIRCLE and ARC carry
 * that, and the rest — text styles, viewports, blocks — is skipped rather
 * than half-understood.
 *
 * Nothing here guesses. A file that yields no coordinates is reported as
 * unreadable rather than returned as an empty survey, because an empty survey
 * looks like a successful import of a site with nothing on it.
 */

import type { Coordinates } from '@surveyor/contracts';

import type { InputProblem } from '../input.js';

export interface DxfEntity {
  readonly kind: 'point' | 'line' | 'polyline' | 'circle' | 'arc';
  readonly layer: string;
  readonly vertices: readonly Coordinates[];
  /** Present on circles and arcs. */
  readonly radius?: number;
  readonly closed?: boolean;
}

export interface DxfDocument {
  readonly entities: readonly DxfEntity[];
  readonly problems: readonly InputProblem[];
}

/** One group: a numeric code and its value, which is all DXF is. */
interface Group {
  readonly code: number;
  readonly value: string;
  readonly line: number;
}

/**
 * Whether this text is a drawing rather than a table.
 *
 * By shape, not by file extension: a DXF renamed `.txt`, or one pasted
 * straight into a box meant for coordinates, is still a DXF — and feeding it
 * to the table extractor would find numbers in it and build a survey out of
 * group codes. The opening `0 / SECTION` pair is the one thing every DXF
 * begins with and no coordinate table ever does.
 */
export function looksLikeDxf(text: string): boolean {
  return /^\s*0\s*[\r\n]+\s*SECTION\b/i.test(text);
}

export function parseDxf(text: string): DxfDocument {
  const groups = readGroups(text);
  const entities: DxfEntity[] = [];
  const problems: InputProblem[] = [];

  let index = 0;
  // Skip to ENTITIES; everything before it is tables and headers.
  while (index < groups.length) {
    const group = groups[index]!;
    if (group.code === 2 && group.value === 'ENTITIES') break;
    index += 1;
  }

  if (index >= groups.length) {
    return {
      entities: [],
      problems: [
        {
          line: 0,
          text: '',
          message: 'This file has no ENTITIES section, so there is no geometry in it to read.',
        },
      ],
    };
  }

  index += 1;

  while (index < groups.length) {
    const group = groups[index]!;
    if (group.code === 0 && group.value === 'ENDSEC') break;

    if (group.code !== 0) {
      index += 1;
      continue;
    }

    const type = group.value;
    const start = index;
    index += 1;

    // Collect this entity's groups: everything up to the next 0 code.
    const own: Group[] = [];
    while (index < groups.length && groups[index]!.code !== 0) {
      own.push(groups[index]!);
      index += 1;
    }

    const entity = toEntity(type, own);
    if (entity) entities.push(entity);
    else if (INTERESTING.has(type)) {
      problems.push({
        line: groups[start]!.line,
        text: type,
        message: `I could not read the coordinates of this ${type}.`,
      });
    }
  }

  if (entities.length === 0) {
    problems.push({
      line: 0,
      text: '',
      message:
        'I read the file but found no points, lines or polylines in it. ' +
        'It may be a drawing of something other than a survey.',
    });
  }

  return { entities, problems };
}

const INTERESTING = new Set(['POINT', 'LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC']);

function toEntity(type: string, groups: readonly Group[]): DxfEntity | null {
  const layer = value(groups, 8) ?? '0';

  switch (type) {
    case 'POINT': {
      const at = coordinate(groups, 0);
      return at ? { kind: 'point', layer, vertices: [at] } : null;
    }
    case 'LINE': {
      const from = coordinate(groups, 0);
      const to = coordinate(groups, 1);
      return from && to ? { kind: 'line', layer, vertices: [from, to] } : null;
    }
    case 'LWPOLYLINE': {
      // A lightweight polyline repeats code 10/20 per vertex, so they are read
      // in order rather than by index.
      const vertices = pairs(groups);
      if (vertices.length < 2) return null;
      const flags = Number(value(groups, 70) ?? '0');
      return { kind: 'polyline', layer, vertices, closed: (flags & 1) === 1 };
    }
    case 'CIRCLE': {
      const centre = coordinate(groups, 0);
      const radius = Number(value(groups, 40));
      return centre && Number.isFinite(radius)
        ? { kind: 'circle', layer, vertices: [centre], radius }
        : null;
    }
    case 'ARC': {
      const centre = coordinate(groups, 0);
      const radius = Number(value(groups, 40));
      return centre && Number.isFinite(radius)
        ? { kind: 'arc', layer, vertices: [centre], radius }
        : null;
    }
    default:
      // POLYLINE's vertices arrive as separate VERTEX entities, which this
      // reader does not stitch back together. Skipped rather than returned
      // half-read: a polyline missing its vertices is a line to nowhere.
      return null;
  }
}

/**
 * A coordinate from the nth x/y pair.
 *
 * DXF numbers its axes by offset — 10/20 is the first point, 11/21 the second
 * — which is why this takes an index rather than a code. Eastings and
 * northings map to x and y directly; DXF has no opinion about what they mean.
 */
function coordinate(groups: readonly Group[], index: number): Coordinates | null {
  const easting = Number(value(groups, 10 + index));
  const northing = Number(value(groups, 20 + index));
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;

  const elevation = Number(value(groups, 30 + index));
  return {
    easting,
    northing,
    ...(Number.isFinite(elevation) && elevation !== 0 ? { elevation } : {}),
  };
}

/** Every 10/20 pair in order, for entities that repeat them. */
function pairs(groups: readonly Group[]): readonly Coordinates[] {
  const vertices: Coordinates[] = [];
  let pending: number | null = null;

  for (const group of groups) {
    if (group.code === 10) pending = Number(group.value);
    else if (group.code === 20 && pending !== null) {
      const northing = Number(group.value);
      if (Number.isFinite(pending) && Number.isFinite(northing)) {
        vertices.push({ easting: pending, northing });
      }
      pending = null;
    }
  }
  return vertices;
}

function value(groups: readonly Group[], code: number): string | undefined {
  return groups.find((group) => group.code === code)?.value;
}

/**
 * DXF is pairs of lines: a numeric code, then its value.
 *
 * Tolerant of both line endings and of leading whitespace, because a file that
 * has been through a Windows editor, a mail client and a zip is still a file
 * the surveyor expects to open.
 */
function readGroups(text: string): readonly Group[] {
  const lines = text.split(/\r?\n/);
  const groups: Group[] = [];

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isInteger(code)) continue;
    groups.push({ code, value: lines[i + 1]!.trim(), line: i + 1 });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Into a survey
// ---------------------------------------------------------------------------

export interface DxfImport {
  readonly points: readonly { readonly id: string; readonly coordinates: Coordinates }[];
  /** Closed polylines, offered as boundary candidates. */
  readonly rings: readonly (readonly Coordinates[])[];
  readonly problems: readonly InputProblem[];
}

/**
 * Turn a DXF into the two things a survey starts from: named points and a
 * closed outline.
 *
 * The largest closed polyline is treated as the boundary candidate, which is
 * right far more often than not — a site plan's outer edge is its biggest
 * closed shape. It is offered rather than applied, because "far more often
 * than not" is not a standard to import someone's boundary on.
 */
export function dxfToSurvey(document: DxfDocument): DxfImport {
  const points = document.entities
    .filter((entity) => entity.kind === 'point')
    .flatMap((entity, index) =>
      entity.vertices[0] ? [{ id: `PT${index + 1}`, coordinates: entity.vertices[0] }] : [],
    );

  const rings = document.entities
    .filter((entity) => entity.kind === 'polyline' && entity.closed === true)
    .map((entity) => entity.vertices)
    .filter((vertices) => vertices.length >= 3)
    .sort((a, b) => b.length - a.length);

  return { points, rings, problems: document.problems };
}
