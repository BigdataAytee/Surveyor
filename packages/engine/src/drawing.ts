/**
 * Drawing Engine (Architecture A.3).
 *
 * Turns validated geometry into drawable primitives. It makes no labelling
 * decisions — that is the Labeling Engine's job, and keeping the split means a
 * change to label rules never risks moving a boundary line.
 *
 * Output stays in survey coordinates. Projection onto a sheet happens in the
 * Plan Composer, and onto a screen in the canvas, so the same drawing feeds an
 * A3 PDF and a phone viewport without being rebuilt.
 */

import type {
  Coordinates,
  FeatureKind,
  Provenance,
  SiteFeature,
  SurveyDataModel,
  SurveyPoint,
} from '@surveyor/contracts';

import { boundsOf, tessellateCurve, type ResolvedRing } from './cogo.js';

/** Where an element came from, so the canvas can highlight it (B.13). */
export type ElementSubject =
  | { readonly kind: 'point'; readonly pointId: string }
  | { readonly kind: 'segment'; readonly from: string; readonly to: string }
  | { readonly kind: 'ring'; readonly ringId: string }
  | { readonly kind: 'feature'; readonly featureId: string };

/**
 * Semantic style class, resolved to real strokes by the renderer or the
 * jurisdiction template. The engine never emits colours or pixel widths.
 */
export type StrokeStyle =
  | 'boundary'
  | 'boundary-curve'
  | 'building'
  | 'road'
  | 'road-centreline'
  | 'fence'
  | 'access'
  | 'water'
  | 'vegetation'
  | 'easement'
  | 'wall'
  | 'utility'
  | 'annotation'
  /** The witness and dimension lines of a dimension the surveyor placed. */
  | 'dimension'
  | 'point-marker';

export type PointSymbol =
  | 'survey-station'
  | 'boundary-corner'
  | 'found-marker'
  /** A spot height — drawn as a cross with its level beside it. */
  | 'level'
  /** A benchmark, which the levels on the plan are measured from. */
  | 'benchmark'
  | 'tree'
  | 'gate'
  | 'generic';

export type DrawingElement =
  | {
      readonly kind: 'polyline';
      readonly id: string;
      readonly points: readonly Coordinates[];
      readonly style: StrokeStyle;
      readonly subject: ElementSubject;
      readonly provenance: Provenance;
      readonly closed?: boolean;
    }
  | {
      readonly kind: 'polygon';
      readonly id: string;
      readonly points: readonly Coordinates[];
      readonly style: StrokeStyle;
      readonly subject: ElementSubject;
      readonly provenance: Provenance;
    }
  | {
      readonly kind: 'symbol';
      readonly id: string;
      readonly at: Coordinates;
      readonly symbol: PointSymbol;
      readonly subject: ElementSubject;
      readonly provenance: Provenance;
    };

export type LayerId = 'boundary' | 'features' | 'points' | 'dimensions';

export interface DrawingLayer {
  readonly id: LayerId;
  readonly name: string;
  readonly elements: readonly DrawingElement[];
}

export interface Drawing {
  readonly layers: readonly DrawingLayer[];
  readonly bounds: { readonly min: Coordinates; readonly max: Coordinates };
}

const FEATURE_STYLE: Readonly<Record<FeatureKind, StrokeStyle>> = {
  building: 'building',
  road: 'road',
  driveway: 'road',
  fence: 'fence',
  wall: 'wall',
  gate: 'fence',
  access: 'access',
  water: 'water',
  vegetation: 'vegetation',
  tree: 'vegetation',
  utility: 'utility',
  easement: 'easement',
  level: 'point-marker',
  benchmark: 'point-marker',
  annotation: 'annotation',
  other: 'building',
};

/** The symbol a point-shaped feature is drawn with. */
const FEATURE_SYMBOL: Readonly<Partial<Record<FeatureKind, PointSymbol>>> = {
  level: 'level',
  benchmark: 'benchmark',
  tree: 'tree',
  gate: 'gate',
};

/**
 * How finely a circle or arc is broken into straight segments.
 *
 * Fixed rather than adaptive, because the drawing this produces is the same
 * one the exporter writes: a circle that was smooth on screen and faceted on
 * the sheet would be two different circles. 64 segments keeps the chord error
 * under a thousandth of the radius, which is finer than any plan scale can
 * show.
 */
const CIRCLE_SEGMENTS = 64;

function arcPoints(
  centre: Coordinates,
  radius: number,
  startBearing: number,
  endBearing: number,
  closed: boolean,
): readonly Coordinates[] {
  // Bearings are clockwise from north, as everywhere else in the system.
  const sweep = closed ? 360 : normaliseSweep(startBearing, endBearing);
  const steps = Math.max(2, Math.round((CIRCLE_SEGMENTS * Math.abs(sweep)) / 360));
  const points: Coordinates[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const bearing = startBearing + (sweep * i) / steps;
    const radians = (bearing * Math.PI) / 180;
    points.push({
      easting: centre.easting + radius * Math.sin(radians),
      northing: centre.northing + radius * Math.cos(radians),
    });
  }
  return points;
}

function normaliseSweep(from: number, to: number): number {
  const raw = (to - from) % 360;
  return raw < 0 ? raw + 360 : raw;
}

/** How finely arcs are tessellated. Fine enough that a 1:200 plot looks smooth. */
const CURVE_SEGMENTS = 32;

export interface DrawingInput {
  readonly model: SurveyDataModel;
  readonly rings: readonly ResolvedRing[];
}

export function buildDrawing(input: DrawingInput): Drawing {
  const boundary = boundaryElements(input.rings);
  const features = featureElements(input.model.siteFeatures);
  const points = pointElements(input.model.points, input.rings);
  const dimensions = dimensionElements(input.model);

  const everyCoordinate = [
    ...boundary.flatMap(coordinatesOf),
    ...features.flatMap(coordinatesOf),
    ...points.flatMap(coordinatesOf),
    ...dimensions.flatMap(coordinatesOf),
  ];

  return {
    layers: [
      { id: 'boundary', name: 'Boundary', elements: boundary },
      { id: 'features', name: 'Site features', elements: features },
      { id: 'points', name: 'Survey points', elements: points },
      { id: 'dimensions', name: 'Dimensions', elements: dimensions },
    ],
    bounds:
      everyCoordinate.length > 0
        ? boundsOf(everyCoordinate)
        : {
            min: { easting: 0, northing: 0 },
            max: { easting: 0, northing: 0 },
          },
  };
}

function coordinatesOf(element: DrawingElement): readonly Coordinates[] {
  return element.kind === 'symbol' ? [element.at] : element.points;
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

function boundaryElements(rings: readonly ResolvedRing[]): DrawingElement[] {
  const elements: DrawingElement[] = [];

  for (const ring of rings) {
    // Each segment is its own element so a single line can be selected,
    // highlighted, and labelled independently of the ring it belongs to.
    for (const segment of ring.segments) {
      const points = segment.curve
        ? tessellateCurve(segment.start, segment.end, segment.curve, CURVE_SEGMENTS)
        : [segment.start, segment.end];

      elements.push({
        kind: 'polyline',
        id: `${ring.ringId}:${segment.from}-${segment.to}`,
        points,
        style: segment.curve ? 'boundary-curve' : 'boundary',
        subject: { kind: 'segment', from: segment.from, to: segment.to },
        provenance: { source: segment.derivedEndpoint ? 'calculated' : 'measured' },
      });
    }
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function featureElements(features: readonly SiteFeature[]): DrawingElement[] {
  const elements: DrawingElement[] = [];

  for (const feature of features) {
    const style = FEATURE_STYLE[feature.type];
    const subject: ElementSubject = { kind: 'feature', featureId: feature.id };

    switch (feature.geometry.kind) {
      case 'polygon':
        elements.push({
          kind: 'polygon',
          id: feature.id,
          points: feature.geometry.vertices,
          style,
          subject,
          provenance: feature.provenance,
        });
        break;
      case 'polyline':
        elements.push({
          kind: 'polyline',
          id: feature.id,
          points: feature.geometry.vertices,
          style,
          subject,
          provenance: feature.provenance,
        });
        break;
      case 'point':
        elements.push({
          kind: 'symbol',
          id: feature.id,
          at: feature.geometry.at,
          symbol: FEATURE_SYMBOL[feature.type] ?? 'generic',
          subject,
          provenance: feature.provenance,
        });
        break;
      case 'circle':
        // Closed, so it is an area with a real radius rather than a loop of
        // vertices that happens to look round.
        elements.push({
          kind: 'polygon',
          id: feature.id,
          points: arcPoints(feature.geometry.centre, feature.geometry.radius, 0, 360, true),
          style,
          subject,
          provenance: feature.provenance,
        });
        break;
      case 'arc':
        elements.push({
          kind: 'polyline',
          id: feature.id,
          points: arcPoints(
            feature.geometry.centre,
            feature.geometry.radius,
            feature.geometry.startBearing,
            feature.geometry.endBearing,
            false,
          ),
          style,
          subject,
          provenance: feature.provenance,
        });
        break;
    }
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Placed dimensions
// ---------------------------------------------------------------------------

/**
 * How far off the measured line a dimension is drawn, per offset step, as a
 * fraction of the distance it measures.
 *
 * Proportional rather than absolute because the alternative is a constant in
 * metres, and a 2 m offset that sits neatly beside a 40 m boundary swallows a
 * 1.5 m setback whole. Scaling with the measurement keeps the same visual
 * relationship at every size.
 */
const DIMENSION_OFFSET_FRACTION = 0.08;

/** How long the witness lines run past the dimension line. */
const WITNESS_OVERSHOOT = 0.25;

/**
 * The geometry of a dimension: two witness lines and the line between them.
 *
 * The text is not here — it is a label specification, so that it goes through
 * the same placement and collision pass as every other label rather than being
 * stamped on the drawing where it may land on top of something.
 *
 * A dimension whose points have gone is dropped rather than drawn to nowhere.
 * That happens: a point is deleted, and the dimension that measured to it no
 * longer measures anything.
 */
function dimensionElements(model: SurveyDataModel): readonly DrawingElement[] {
  const byId = new Map(model.points.map((point) => [point.id, point.coordinates]));
  const elements: DrawingElement[] = [];

  for (const dimension of model.dimensions ?? []) {
    const start = byId.get(dimension.from);
    const end = byId.get(dimension.to);
    if (!start || !end) continue;

    const dE = end.easting - start.easting;
    const dN = end.northing - start.northing;
    const length = Math.hypot(dE, dN);
    if (length === 0) continue;

    // The unit normal to the measured line. Which side it falls on follows
    // from the order the two points were given, which is the order the user
    // picked them in — so reversing a dimension flips it, as it should.
    const offset = length * DIMENSION_OFFSET_FRACTION * (dimension.offsetSteps ?? 1);
    const nE = (-dN / length) * offset;
    const nN = (dE / length) * offset;

    const startOff = { easting: start.easting + nE, northing: start.northing + nN };
    const endOff = { easting: end.easting + nE, northing: end.northing + nN };
    const overshoot = {
      easting: nE * WITNESS_OVERSHOOT,
      northing: nN * WITNESS_OVERSHOOT,
    };

    const subject = {
      kind: 'segment' as const,
      from: dimension.from,
      to: dimension.to,
    };

    elements.push(
      {
        kind: 'polyline',
        id: `${dimension.id}_line`,
        points: [startOff, endOff],
        style: 'dimension',
        subject,
        provenance: dimension.provenance,
      },
      {
        kind: 'polyline',
        id: `${dimension.id}_witness_from`,
        points: [
          start,
          {
            easting: startOff.easting + overshoot.easting,
            northing: startOff.northing + overshoot.northing,
          },
        ],
        style: 'dimension',
        subject,
        provenance: dimension.provenance,
      },
      {
        kind: 'polyline',
        id: `${dimension.id}_witness_to`,
        points: [
          end,
          {
            easting: endOff.easting + overshoot.easting,
            northing: endOff.northing + overshoot.northing,
          },
        ],
        style: 'dimension',
        subject,
        provenance: dimension.provenance,
      },
    );
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Survey points
// ---------------------------------------------------------------------------

function pointElements(
  points: readonly SurveyPoint[],
  rings: readonly ResolvedRing[],
): DrawingElement[] {
  const corners = new Set<string>();
  for (const ring of rings) {
    for (const segment of ring.segments) {
      corners.add(segment.from);
      corners.add(segment.to);
    }
  }

  return points.map((point) => ({
    kind: 'symbol' as const,
    id: point.id,
    at: point.coordinates,
    symbol: corners.has(point.id)
      ? ('boundary-corner' as const)
      : ('survey-station' as const),
    subject: { kind: 'point' as const, pointId: point.id },
    provenance: point.provenance,
  }));
}

/** Every element on the drawing, flattened. Convenient for hit testing. */
export function allElements(drawing: Drawing): readonly DrawingElement[] {
  return drawing.layers.flatMap((layer) => layer.elements);
}

export function findElement(
  drawing: Drawing,
  id: string,
): DrawingElement | undefined {
  return allElements(drawing).find((element) => element.id === id);
}
