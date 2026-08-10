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
  | 'point-marker';

export type PointSymbol =
  | 'survey-station'
  | 'boundary-corner'
  | 'found-marker'
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

export type LayerId = 'boundary' | 'features' | 'points';

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
  fence: 'fence',
  access: 'access',
  water: 'water',
  vegetation: 'vegetation',
  easement: 'easement',
  other: 'building',
};

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

  const everyCoordinate = [
    ...boundary.flatMap(coordinatesOf),
    ...features.flatMap(coordinatesOf),
    ...points.flatMap(coordinatesOf),
  ];

  return {
    layers: [
      { id: 'boundary', name: 'Boundary', elements: boundary },
      { id: 'features', name: 'Site features', elements: features },
      { id: 'points', name: 'Survey points', elements: points },
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
          symbol: 'generic',
          subject,
          provenance: feature.provenance,
        });
        break;
    }
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
