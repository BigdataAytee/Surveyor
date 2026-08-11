/**
 * Label Placement Engine (Architecture A.3) — the deterministic half.
 *
 * Consumes LabelSpecifications, which describe intent, and decides position,
 * orientation and collision resolution. This is the only place in the system
 * that turns a labelling intent into coordinates.
 *
 * The algorithm is the greedy one A.4 calls for: rank by priority, generate
 * ranked candidates per label, take the first that collides with nothing, fall
 * back to a leader line, and report anything that had to be dropped. It works
 * in survey coordinates, sizing text through the plan scale, so the same pass
 * serves an A3 sheet and a phone screen.
 */

import type {
  BoundingBox,
  Coordinates,
  LabelSpecification,
  LabelSubject,
  LinearUnit,
  PlacedLabel,
  PlacementResult,
  PlanPoint,
  SiteFeature,
  VisibilityPolicy,
} from '@surveyor/contracts';

import {
  centroid,
  forward,
  inverse,
  pointInPolygon,
  type ResolvedRing,
  type ResolvedSegment,
} from '../cogo.js';
import { fromMetres, normalizeAzimuth } from '../crs.js';
import { looseSegment, renderContent, type LabelContext } from './templates.js';

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------

/**
 * Advance widths as a fraction of cap height, for a technical sans-serif.
 *
 * An estimate is the right tool here: the engine must size text without a font
 * rasterizer, and placement only needs to know when two labels would touch.
 * The estimate runs slightly wide, so collisions are caught rather than missed.
 */
const NARROW = new Set('iljtIf.,:;\'"|!'.split(''));
const WIDE = new Set('mwMW@'.split(''));

export function estimateTextWidth(text: string, height: number): number {
  let ratio = 0;
  for (const char of text) {
    if (char === ' ') ratio += 0.32;
    else if (NARROW.has(char)) ratio += 0.32;
    else if (WIDE.has(char)) ratio += 0.92;
    else if (char === '°' || char === '²') ratio += 0.42;
    else ratio += 0.62;
  }
  return ratio * height;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AvoidArea {
  /** The feature this area belongs to, so its own labels can sit inside it. */
  readonly ownerId: string;
  readonly vertices: readonly Coordinates[];
}

export interface PlacementOptions {
  /** Plan scale denominator: 200 means 1:200. */
  readonly scaleDenominator: number;
  /** Cap height of label text on paper, in millimetres. */
  readonly textHeightMm: number;
  /** Minimum gap between a label and anything else, in millimetres. */
  readonly clearanceMm: number;
  /** Drawing lines labels must avoid crossing, in survey coordinates. */
  readonly obstacles?: readonly (readonly Coordinates[])[];
  /**
   * Filled areas a label must not sit on top of — buildings, water, and the
   * like. Distinct from `obstacles`: those are lines a label must not cross,
   * whereas these are regions it must stay out of even when it clears the
   * edges. Without this a parcel's area label happily lands inside the house.
   *
   * Each area carries the id of the feature it belongs to, because a feature's
   * own labels must still be allowed inside it — a building's name belongs in
   * the building, not on a leader line pointing at it.
   */
  readonly avoidAreas?: readonly AvoidArea[];
  /** The drawable area, in survey coordinates. Labels stay inside it. */
  readonly sheetBounds?: { readonly min: Coordinates; readonly max: Coordinates };
  /** Where sheet-anchored labels (notes) stack. */
  readonly sheetAnchor?: PlanPoint;
}

export const DEFAULT_PLACEMENT_OPTIONS: Omit<PlacementOptions, 'scaleDenominator'> = {
  textHeightMm: 2.5,
  clearanceMm: 0.8,
};

export interface PlacementInput {
  readonly specs: readonly LabelSpecification[];
  readonly ctx: LabelContext;
  readonly options: PlacementOptions;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function toPlanPoint(c: Coordinates): PlanPoint {
  return { x: c.easting, y: c.northing };
}

function toCoordinates(p: PlanPoint): Coordinates {
  return { easting: p.x, northing: p.y };
}

/** Axis-aligned bounds of a text box rotated about its centre. */
export function orientedBounds(
  centre: PlanPoint,
  width: number,
  height: number,
  rotationDegrees: number,
): BoundingBox {
  const rad = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = width / 2;
  const hh = height / 2;

  const extentX = Math.abs(hw * cos) + Math.abs(hh * sin);
  const extentY = Math.abs(hw * sin) + Math.abs(hh * cos);

  return {
    min: { x: centre.x - extentX, y: centre.y - extentY },
    max: { x: centre.x + extentX, y: centre.y + extentY },
  };
}

function boxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y
  );
}

/**
 * The four corners of a rotated text box.
 *
 * Collision has to be tested against this rather than the axis-aligned bounds:
 * a dimension running along a near-vertical boundary has an axis-aligned box
 * several metres wide, which always appears to touch the very line the label
 * belongs to. Testing the real rectangle is what lets such a label sit neatly
 * beside its line instead of being exiled to a leader.
 */
export function orientedCorners(
  centre: PlanPoint,
  width: number,
  height: number,
  rotationDegrees: number,
): readonly PlanPoint[] {
  const rad = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = width / 2;
  const hh = height / 2;

  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => ({
    x: centre.x + dx! * cos - dy! * sin,
    y: centre.y + dx! * sin + dy! * cos,
  }));
}

/** Separating-axis test for two convex polygons. */
function convexOverlap(a: readonly PlanPoint[], b: readonly PlanPoint[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const p = polygon[i]!;
      const q = polygon[(i + 1) % polygon.length]!;
      // Outward normal of this edge.
      const axis = { x: -(q.y - p.y), y: q.x - p.x };
      const length = Math.hypot(axis.x, axis.y);
      if (length < 1e-12) continue;

      const spanA = project(a, axis);
      const spanB = project(b, axis);
      if (spanA.max < spanB.min || spanB.max < spanA.min) return false;
    }
  }
  return true;
}

function project(
  polygon: readonly PlanPoint[],
  axis: PlanPoint,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of polygon) {
    const value = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

function boxContains(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.min.x >= outer.min.x &&
    inner.max.x <= outer.max.x &&
    inner.min.y >= outer.min.y &&
    inner.max.y <= outer.max.y
  );
}

/** True when a line segment touches a rotated rectangle. */
function segmentHitsRect(
  a: PlanPoint,
  b: PlanPoint,
  corners: readonly PlanPoint[],
): boolean {
  if (pointInConvex(a, corners) || pointInConvex(b, corners)) return true;
  for (let i = 0; i < corners.length; i += 1) {
    if (segmentsIntersect(a, b, corners[i]!, corners[(i + 1) % corners.length]!)) {
      return true;
    }
  }
  return false;
}

/** Point containment for a convex polygon wound in either direction. */
function pointInConvex(p: PlanPoint, polygon: readonly PlanPoint[]): boolean {
  let positive = false;
  let negative = false;

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross > 1e-12) positive = true;
    if (cross < -1e-12) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

function segmentsIntersect(
  p1: PlanPoint,
  p2: PlanPoint,
  p3: PlanPoint,
  p4: PlanPoint,
): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ---------------------------------------------------------------------------
// Subject resolution
// ---------------------------------------------------------------------------

type SubjectGeometry =
  | { readonly kind: 'point'; readonly at: Coordinates }
  | { readonly kind: 'segment'; readonly segment: ResolvedSegment }
  | { readonly kind: 'area'; readonly vertices: readonly Coordinates[] }
  | { readonly kind: 'sheet' };

function resolveSubject(
  subject: LabelSubject,
  ctx: LabelContext,
): SubjectGeometry | null {
  switch (subject.kind) {
    case 'point': {
      const point = ctx.model.points.find((p) => p.id === subject.pointId);
      return point ? { kind: 'point', at: point.coordinates } : null;
    }
    case 'segment': {
      for (const ring of ctx.rings) {
        const segment = ring.segments.find(
          (s) => s.from === subject.from && s.to === subject.to,
        );
        if (segment) return { kind: 'segment', segment };
      }

      // A placed dimension measures between two points that need not be
      // neighbours on a boundary. Resolved by the same call the text uses, so
      // the label cannot end up positioned along one line and reading another.
      const loose = looseSegment(subject.from, subject.to, ctx);
      return loose ? { kind: 'segment', segment: loose } : null;
    }
    case 'ring': {
      const ring = ctx.rings.find((r) => r.ringId === subject.ringId);
      return ring ? { kind: 'area', vertices: ring.vertices } : null;
    }
    case 'feature': {
      const feature = ctx.model.siteFeatures.find((f) => f.id === subject.featureId);
      return feature ? featureGeometry(feature) : null;
    }
    case 'sheet':
      return { kind: 'sheet' };
  }
}

function featureGeometry(feature: SiteFeature): SubjectGeometry {
  switch (feature.geometry.kind) {
    case 'polygon':
      return { kind: 'area', vertices: feature.geometry.vertices };
    case 'polyline': {
      // Label a linear feature along its longest leg, which is where a road
      // name reads best.
      const vertices = feature.geometry.vertices;
      let best = { from: 0, length: -1 };
      for (let i = 0; i < vertices.length - 1; i += 1) {
        const { distance } = inverse(vertices[i]!, vertices[i + 1]!);
        if (distance > best.length) best = { from: i, length: distance };
      }
      const start = vertices[best.from] ?? { easting: 0, northing: 0 };
      const end = vertices[best.from + 1] ?? start;
      const { bearing, distance } = inverse(start, end);
      return {
        kind: 'segment',
        segment: {
          from: `${feature.id}:${best.from}`,
          to: `${feature.id}:${best.from + 1}`,
          start,
          end,
          bearing,
          distance,
          derivedEndpoint: false,
        },
      };
    }
    case 'point':
      return { kind: 'point', at: feature.geometry.at };
    case 'circle':
      // Labelled at its centre, which is the only place on a circle that is
      // not on its edge.
      return { kind: 'point', at: feature.geometry.centre };
    case 'arc':
      return { kind: 'point', at: feature.geometry.centre };
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate {
  readonly position: PlanPoint;
  readonly rotation: number;
  readonly viaLeader: boolean;
  readonly anchorOn?: PlanPoint;
}

/** Text along a line reads with the line; upside-down text is flipped. */
function rotationForBearing(bearing: number, keepUpright: boolean): number {
  // Azimuth is clockwise from north; screen rotation is counter-clockwise from
  // the easting axis, hence 90 - azimuth.
  let rotation = 90 - normalizeAzimuth(bearing);
  if (rotation > 180) rotation -= 360;
  if (rotation < -180) rotation += 360;

  if (keepUpright && (rotation > 90 || rotation < -90)) {
    rotation += rotation > 0 ? -180 : 180;
  }
  return rotation;
}

interface CandidateContext {
  readonly width: number;
  readonly height: number;
  readonly clearance: number;
  readonly offsetSteps: number;
  readonly keepUpright: boolean;
  readonly side: LabelSpecification['anchor']['side'];
}

function alongCandidates(
  segment: ResolvedSegment,
  cc: CandidateContext,
): Candidate[] {
  const rotation = rotationForBearing(segment.bearing, cc.keepUpright);
  const base = cc.height * 0.75 + cc.clearance;
  const step = cc.height * Math.max(cc.offsetSteps, 1);

  const positions: Candidate[] = [];
  // Try the middle first, then thirds — a dimension reads best centred, but a
  // crowded corner is a good reason to slide along the line.
  for (const fraction of [0.5, 0.35, 0.65]) {
    const anchor = forward(segment.start, segment.bearing, segment.distance * fraction);
    const sides: number[] =
      cc.side === 'left' ? [-90] : cc.side === 'right' ? [90] : [-90, 90];

    for (const side of sides) {
      for (let ring = 0; ring < 2; ring += 1) {
        const offset = base + step * ring;
        positions.push({
          position: toPlanPoint(
            forward(anchor, segment.bearing + side, offset),
          ),
          rotation,
          viaLeader: false,
        });
      }
    }
  }
  return positions;
}

function nearCandidates(at: Coordinates, cc: CandidateContext): Candidate[] {
  const radius = cc.clearance + cc.height * (0.9 + 0.6 * Math.max(cc.offsetSteps - 1, 0));
  // Corner positions first: standard drafting practice puts a point id off the
  // diagonal so it clears both lines meeting at the corner.
  const bearings = [45, 315, 135, 225, 0, 90, 180, 270];

  return bearings.flatMap((bearing) =>
    [0, 1].map((ring) => {
      const distance = radius + ring * cc.height * 1.4;
      const centre = forward(at, bearing, distance + cc.width / 2.4);
      return { position: toPlanPoint(centre), rotation: 0, viaLeader: false };
    }),
  );
}

function offsetCandidates(
  geometry: SubjectGeometry,
  cc: CandidateContext,
): Candidate[] {
  if (geometry.kind === 'segment') {
    const mid = forward(
      geometry.segment.start,
      geometry.segment.bearing,
      geometry.segment.distance / 2,
    );
    return [-90, 90].flatMap((side) =>
      [1, 2, 3].map((ring) => ({
        position: toPlanPoint(
          forward(mid, geometry.segment.bearing + side, cc.height * ring + cc.clearance),
        ),
        rotation: 0,
        viaLeader: false,
      })),
    );
  }
  if (geometry.kind === 'point') {
    return nearCandidates(geometry.at, cc);
  }
  if (geometry.kind === 'area') {
    return insideCandidates(geometry.vertices, cc);
  }
  return [];
}

function insideCandidates(
  vertices: readonly Coordinates[],
  cc: CandidateContext,
): Candidate[] {
  const middle = centroid(vertices);
  const candidates: Candidate[] = [{ position: toPlanPoint(middle), rotation: 0, viaLeader: false }];

  // Search outward from the centre before giving up on an interior label. A
  // parcel label whose centroid falls on the house has plenty of clear garden
  // to sit in, and finding it beats dragging a leader line across the building.
  for (let ring = 1; ring <= 5; ring += 1) {
    for (const bearing of [0, 180, 90, 270, 45, 135, 225, 315]) {
      const shifted = forward(middle, bearing, cc.height * 2 * ring);
      if (pointInPolygon(shifted, vertices)) {
        candidates.push({ position: toPlanPoint(shifted), rotation: 0, viaLeader: false });
      }
    }
  }
  return candidates;
}

function leaderCandidates(
  geometry: SubjectGeometry,
  cc: CandidateContext,
): Candidate[] {
  const anchor =
    geometry.kind === 'point'
      ? geometry.at
      : geometry.kind === 'area'
        ? centroid(geometry.vertices)
        : geometry.kind === 'segment'
          ? forward(
              geometry.segment.start,
              geometry.segment.bearing,
              geometry.segment.distance / 2,
            )
          : null;
  if (!anchor) return [];

  const candidates: Candidate[] = [];
  for (let ring = 2; ring <= 6; ring += 1) {
    for (const bearing of [45, 315, 135, 225, 0, 90, 180, 270]) {
      const distance = cc.height * 2.2 * ring;
      candidates.push({
        position: toPlanPoint(forward(anchor, bearing, distance + cc.width / 2)),
        rotation: 0,
        viaLeader: true,
        anchorOn: toPlanPoint(anchor),
      });
    }
  }
  return candidates;
}

function candidatesFor(
  spec: LabelSpecification,
  geometry: SubjectGeometry,
  cc: CandidateContext,
): Candidate[] {
  const order = spec.anchor.preferredOrder ?? [spec.anchor.relation];
  const relations = order.includes(spec.anchor.relation)
    ? order
    : [spec.anchor.relation, ...order];

  const candidates: Candidate[] = [];
  for (const relation of relations) {
    switch (relation) {
      case 'along':
        if (geometry.kind === 'segment') {
          candidates.push(...alongCandidates(geometry.segment, cc));
        }
        break;
      case 'near':
        if (geometry.kind === 'point') candidates.push(...nearCandidates(geometry.at, cc));
        break;
      case 'inside':
        if (geometry.kind === 'area') {
          candidates.push(...insideCandidates(geometry.vertices, cc));
        }
        break;
      case 'offset':
        candidates.push(...offsetCandidates(geometry, cc));
        break;
      case 'leader':
        candidates.push(...leaderCandidates(geometry, cc));
        break;
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const VISIBILITY_RANK: Readonly<Record<VisibilityPolicy, number>> = {
  required: 0,
  preferred: 1,
  optional: 2,
};

/** World units per millimetre of paper at a given scale. */
export function worldUnitsPerMm(
  scaleDenominator: number,
  units: LinearUnit,
): number {
  return fromMetres(scaleDenominator / 1000, units);
}

export function placeLabels(input: PlacementInput): PlacementResult {
  const { specs, ctx, options } = input;
  const perMm = worldUnitsPerMm(options.scaleDenominator, ctx.model.crs.units);
  const height = options.textHeightMm * perMm;
  const clearance = options.clearanceMm * perMm;

  const sheetBox: BoundingBox | undefined = options.sheetBounds
    ? {
        min: toPlanPoint(options.sheetBounds.min),
        max: toPlanPoint(options.sheetBounds.max),
      }
    : undefined;

  const ordered = [...specs].sort(
    (a, b) =>
      a.priority - b.priority ||
      VISIBILITY_RANK[a.visibility] - VISIBILITY_RANK[b.visibility] ||
      a.id.localeCompare(b.id),
  );

  const occupied: (readonly PlanPoint[])[] = [];
  const placed: PlacedLabel[] = [];
  const unresolved: { labelId: string; message: string }[] = [];
  let sheetLine = 0;

  for (const spec of ordered) {
    const geometry = resolveSubject(spec.subject, ctx);
    if (!geometry) {
      unresolved.push({
        labelId: spec.id,
        message: `Label "${spec.id}" points at something that is not in the survey.`,
      });
      continue;
    }

    const rendered = renderContent(spec.content, ctx);
    if (!rendered.ok) {
      unresolved.push({ labelId: spec.id, message: rendered.reason });
      continue;
    }

    const width = estimateTextWidth(rendered.text, height);

    // Sheet-anchored text (notes) is stacked rather than fitted around
    // geometry: it belongs to the sheet, not to a feature on it.
    if (geometry.kind === 'sheet') {
      const anchor = options.sheetAnchor ?? { x: 0, y: 0 };
      const position = { x: anchor.x + width / 2, y: anchor.y - sheetLine * height * 1.8 };
      sheetLine += 1;
      const bounds = orientedBounds(position, width, height, 0);
      occupied.push(orientedCorners(position, width, height, 0));
      placed.push({
        spec,
        text: rendered.text,
        position,
        rotation: 0,
        bounds,
        outcome: 'placed',
      });
      continue;
    }

    const cc: CandidateContext = {
      width,
      height,
      clearance,
      offsetSteps: spec.anchor.offsetSteps ?? 1,
      keepUpright: spec.anchor.keepUpright ?? true,
      side: spec.anchor.side,
    };

    const candidates = candidatesFor(spec, geometry, cc);
    const outcome = chooseCandidate(candidates, {
      width,
      height,
      clearance,
      occupied,
      obstacles: options.obstacles ?? [],
      avoidAreas: (options.avoidAreas ?? []).filter(
        (area) => area.ownerId !== subjectOwnerId(spec.subject),
      ),
      sheetBox,
    });

    if (!outcome) {
      placed.push({
        spec,
        text: rendered.text,
        position: fallbackPosition(geometry),
        rotation: 0,
        bounds: orientedBounds(fallbackPosition(geometry), width, height, 0),
        outcome: 'dropped',
        reason:
          spec.visibility === 'required'
            ? 'There is no clear space for this label at the current scale.'
            : 'Left off to keep the drawing readable.',
      });
      continue;
    }

    occupied.push(outcome.corners);
    placed.push({
      spec,
      text: rendered.text,
      position: outcome.candidate.position,
      rotation: outcome.candidate.rotation,
      bounds: outcome.bounds,
      outcome: outcome.candidate.viaLeader
        ? 'placed-with-leader'
        : outcome.index === 0
          ? 'placed'
          : 'displaced',
      ...(outcome.candidate.viaLeader && outcome.candidate.anchorOn
        ? {
            leader: {
              from: outcome.candidate.anchorOn,
              to: outcome.candidate.position,
            },
          }
        : {}),
      ...(outcome.index === 0
        ? {}
        : { reason: 'Moved from its preferred position to avoid a collision.' }),
    });
  }

  return { labels: placed, unresolved };
}

interface ChooseInput {
  readonly width: number;
  readonly height: number;
  readonly clearance: number;
  readonly occupied: readonly (readonly PlanPoint[])[];
  readonly obstacles: readonly (readonly Coordinates[])[];
  readonly avoidAreas: readonly AvoidArea[];
  readonly sheetBox: BoundingBox | undefined;
}

/** Which drawn feature, if any, a label belongs to. */
function subjectOwnerId(subject: LabelSubject): string | null {
  return subject.kind === 'feature' ? subject.featureId : null;
}

function chooseCandidate(
  candidates: readonly Candidate[],
  input: ChooseInput,
):
  | {
      candidate: Candidate;
      bounds: BoundingBox;
      corners: readonly PlanPoint[];
      index: number;
    }
  | null {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const width = input.width + input.clearance;
    const height = input.height + input.clearance;
    const corners = orientedCorners(candidate.position, width, height, candidate.rotation);
    const bounds = orientedBounds(candidate.position, width, height, candidate.rotation);

    // The cheap axis-aligned tests run first and reject most candidates; the
    // exact ones only run on what survives.
    if (input.sheetBox && !boxContains(input.sheetBox, bounds)) continue;
    if (
      input.occupied.some(
        (other) =>
          boxesOverlap(boundsOfCorners(other), bounds) && convexOverlap(other, corners),
      )
    ) {
      continue;
    }
    if (crossesObstacle(corners, input.obstacles)) continue;
    if (insideAvoidedArea(candidate.position, input.avoidAreas)) continue;

    return { candidate, bounds, corners, index };
  }
  return null;
}

function boundsOfCorners(corners: readonly PlanPoint[]): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function crossesObstacle(
  corners: readonly PlanPoint[],
  obstacles: readonly (readonly Coordinates[])[],
): boolean {
  for (const line of obstacles) {
    for (let i = 0; i < line.length - 1; i += 1) {
      if (segmentHitsRect(toPlanPoint(line[i]!), toPlanPoint(line[i + 1]!), corners)) {
        return true;
      }
    }
  }
  return false;
}

function insideAvoidedArea(
  position: PlanPoint,
  areas: readonly AvoidArea[],
): boolean {
  return areas.some((area) => pointInPolygon(toCoordinates(position), area.vertices));
}

function fallbackPosition(geometry: SubjectGeometry): PlanPoint {
  switch (geometry.kind) {
    case 'point':
      return toPlanPoint(geometry.at);
    case 'area':
      return toPlanPoint(centroid(geometry.vertices));
    case 'segment':
      return toPlanPoint(
        forward(
          geometry.segment.start,
          geometry.segment.bearing,
          geometry.segment.distance / 2,
        ),
      );
    case 'sheet':
      return { x: 0, y: 0 };
  }
}

/** Labels that could not be placed but were required — a validation concern. */
export function droppedRequiredLabels(
  result: PlacementResult,
): readonly PlacedLabel[] {
  return result.labels.filter(
    (label) => label.outcome === 'dropped' && label.spec.visibility === 'required',
  );
}

export { toCoordinates };
