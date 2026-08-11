/**
 * Semantic labelling — deciding *what* gets labelled and what it says.
 *
 * A.3 splits the Labeling Engine into a semantic half and a geometric half.
 * This is the semantic half, and it is the seam the AI plugs into: the base
 * set below is what any competent draughtsman would put on the sheet, and the
 * AI layer adds to or removes from it for a particular job.
 *
 * Even so, nothing here writes a survey value. Every specification is built
 * from structured attributes with `derived` content, so the numbers arrive from
 * the templates at render time.
 */

import type {
  Dimension,
  LabelSpecification,
  SiteFeature,
  SurveyDataModel,
} from '@surveyor/contracts';
import { DEFAULT_PRIORITY } from '@surveyor/contracts';

import type { ResolvedRing } from '../cogo.js';

/** Which optional label families to include. Driven by the UI's layer toggles. */
export interface LabelPreferences {
  readonly pointIds: boolean;
  readonly bearingsAndDistances: boolean;
  readonly area: boolean;
  readonly featureNames: boolean;
  readonly featureDimensions: boolean;
  readonly coordinates: boolean;
}

export const DEFAULT_LABEL_PREFERENCES: LabelPreferences = {
  pointIds: true,
  bearingsAndDistances: true,
  area: true,
  featureNames: true,
  featureDimensions: true,
  coordinates: false,
};

export interface SemanticLabelInput {
  readonly model: SurveyDataModel;
  readonly rings: readonly ResolvedRing[];
  readonly preferences?: Partial<LabelPreferences>;
}

/**
 * The baseline label set for a plan. Deterministic: same model in, same
 * specifications out, so a plan does not change because a model was re-asked.
 */
export function generateBaseLabels(
  input: SemanticLabelInput,
): readonly LabelSpecification[] {
  const prefs = { ...DEFAULT_LABEL_PREFERENCES, ...input.preferences };
  const labels: LabelSpecification[] = [];

  for (const ring of input.rings) {
    if (prefs.bearingsAndDistances) {
      labels.push(...segmentLabels(ring));
    }
    if (prefs.area) {
      labels.push(areaLabel(ring));
    }
  }

  if (prefs.pointIds) {
    labels.push(...pointLabels(input.model, input.rings));
  }
  if (prefs.coordinates) {
    labels.push(...coordinateLabels(input.model, input.rings));
  }
  for (const feature of input.model.siteFeatures) {
    labels.push(...featureLabels(feature, prefs));
  }
  for (const dimension of input.model.dimensions ?? []) {
    labels.push(placedDimensionLabel(dimension));
  }

  // Notes are deliberately not label specifications. They belong to the sheet,
  // not to anything on the drawing, and the Plan Composer lays them out in the
  // notes block. Emitting them here as well printed every note twice.
  return labels;
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

function segmentLabels(ring: ResolvedRing): LabelSpecification[] {
  return ring.segments.map((segment) => {
    const ref = { ref: `segment:${segment.from}>${segment.to}` };
    const curved = segment.curve !== undefined;

    return {
      id: `lbl_${ring.ringId}_${segment.from}_${segment.to}`,
      subject: { kind: 'segment', from: segment.from, to: segment.to },
      role: curved ? 'curve-data' : 'bearing',
      content: {
        mode: 'derived',
        template: curved ? 'segment.curveData' : 'segment.bearingDistance',
        bindings: { segment: ref },
      },
      anchor: {
        relation: 'along',
        side: 'auto',
        keepUpright: true,
        offsetSteps: 1,
        preferredOrder: ['along', 'offset', 'leader'],
      },
      priority: curved ? DEFAULT_PRIORITY['curve-data'] : DEFAULT_PRIORITY.bearing,
      // Dimensions are the reason the plan exists; losing one to a collision is
      // a validation failure, not a layout preference.
      visibility: 'required',
      style: { token: 'label.dimension' },
      provenance: { source: 'calculated' },
    } satisfies LabelSpecification;
  });
}

/**
 * The text of a dimension the surveyor placed.
 *
 * `required`, like a boundary dimension: it was placed deliberately, so
 * dropping it under collision pressure would silently discard an instruction.
 * The user can delete it if they change their mind; the layout engine may not
 * decide that for them.
 */
function placedDimensionLabel(dimension: Dimension): LabelSpecification {
  return {
    id: `lbl_${dimension.id}`,
    subject: { kind: 'segment', from: dimension.from, to: dimension.to },
    role: 'dimension',
    content: {
      mode: 'derived',
      template: dimension.showBearing ? 'segment.bearingDistance' : 'segment.distance',
      bindings: { segment: { ref: `segment:${dimension.from}>${dimension.to}` } },
    },
    anchor: {
      relation: 'along',
      side: 'auto',
      keepUpright: true,
      offsetSteps: dimension.offsetSteps ?? 1,
      preferredOrder: ['along', 'offset', 'leader'],
    },
    priority: DEFAULT_PRIORITY.dimension,
    visibility: 'required',
    style: { token: 'label.dimension' },
    // Calculated, whoever asked for it: the number comes from the COGO engine,
    // not from the person who placed the dimension.
    provenance: { source: 'calculated' },
  };
}

function areaLabel(ring: ResolvedRing): LabelSpecification {
  return {
    id: `lbl_${ring.ringId}_area`,
    subject: { kind: 'ring', ringId: ring.ringId },
    role: 'area',
    content: {
      mode: 'derived',
      template: 'ring.area',
      bindings: { ring: { ref: `ring:${ring.ringId}` } },
    },
    anchor: { relation: 'inside', keepUpright: true, preferredOrder: ['inside', 'leader'] },
    priority: DEFAULT_PRIORITY.area,
    visibility: 'preferred',
    style: { token: 'label.area' },
    provenance: { source: 'calculated' },
  };
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

function boundaryCorners(rings: readonly ResolvedRing[]): Set<string> {
  const corners = new Set<string>();
  for (const ring of rings) {
    for (const segment of ring.segments) {
      corners.add(segment.from);
      corners.add(segment.to);
    }
  }
  return corners;
}

function pointLabels(
  model: SurveyDataModel,
  rings: readonly ResolvedRing[],
): LabelSpecification[] {
  const corners = boundaryCorners(rings);

  return model.points
    .filter((point) => corners.has(point.id))
    .map((point) => ({
      id: `lbl_${point.id}_id`,
      subject: { kind: 'point' as const, pointId: point.id },
      role: 'point-id' as const,
      content: {
        mode: 'derived' as const,
        template: 'point.id',
        bindings: { point: { ref: `point:${point.id}` } },
      },
      anchor: {
        relation: 'near' as const,
        side: 'auto' as const,
        keepUpright: true,
        offsetSteps: 1,
        preferredOrder: ['near' as const, 'leader' as const],
      },
      priority: DEFAULT_PRIORITY['point-id'],
      visibility: 'required' as const,
      style: { token: 'label.point-id' },
      // The id names a measured point, so it inherits that point's provenance.
      provenance: point.provenance,
    }));
}

function coordinateLabels(
  model: SurveyDataModel,
  rings: readonly ResolvedRing[],
): LabelSpecification[] {
  const corners = boundaryCorners(rings);

  return model.points
    .filter((point) => corners.has(point.id))
    .map((point) => ({
      id: `lbl_${point.id}_coordinate`,
      subject: { kind: 'point' as const, pointId: point.id },
      role: 'coordinate' as const,
      content: {
        mode: 'derived' as const,
        template: 'point.coordinate',
        bindings: { point: { ref: `point:${point.id}` } },
      },
      anchor: { relation: 'leader' as const, keepUpright: true, offsetSteps: 3 },
      priority: DEFAULT_PRIORITY.coordinate,
      visibility: 'optional' as const,
      style: { token: 'label.coordinate' },
      provenance: point.provenance,
    }));
}

// ---------------------------------------------------------------------------
// Features and notes
// ---------------------------------------------------------------------------

function featureLabels(
  feature: SiteFeature,
  prefs: LabelPreferences,
): LabelSpecification[] {
  const labels: LabelSpecification[] = [];
  const inside = feature.geometry.kind === 'polygon' || feature.geometry.kind === 'circle';

  /*
   * A level is its number. Naming it as well would print "Spot height 45.20"
   * on a drawing where the convention is a cross and a figure, so the level
   * template stands in for the name rather than joining it.
   */
  if (feature.type === 'level' || feature.type === 'benchmark') {
    labels.push({
      id: `lbl_${feature.id}_level`,
      subject: { kind: 'feature', featureId: feature.id },
      role: 'feature-name',
      content: {
        mode: 'derived',
        template: feature.type === 'benchmark' ? 'feature.levelWithName' : 'feature.level',
        bindings: { feature: { ref: `feature:${feature.id}` } },
      },
      anchor: {
        relation: 'near',
        keepUpright: true,
        offsetSteps: 1,
        preferredOrder: ['near', 'offset', 'leader'],
      },
      priority: DEFAULT_PRIORITY['feature-name'],
      visibility: 'preferred',
      style: { token: 'label.feature' },
      provenance: feature.provenance,
    });
    return labels;
  }

  if (prefs.featureNames && feature.attributes.name !== undefined) {
    labels.push({
      id: `lbl_${feature.id}_name`,
      subject: { kind: 'feature', featureId: feature.id },
      role: feature.type === 'road' ? 'road-name' : 'feature-name',
      content: {
        mode: 'derived',
        template: 'feature.name',
        bindings: { feature: { ref: `feature:${feature.id}#name` } },
      },
      anchor: {
        relation: inside ? 'inside' : 'along',
        keepUpright: true,
        offsetSteps: 1,
        preferredOrder: inside ? ['inside', 'near', 'leader'] : ['along', 'offset', 'leader'],
      },
      priority: DEFAULT_PRIORITY['feature-name'],
      visibility: 'preferred',
      style: { token: 'label.feature' },
      provenance: feature.provenance,
    });
  }

  if (prefs.featureDimensions && feature.type === 'building' && inside) {
    labels.push({
      id: `lbl_${feature.id}_dimensions`,
      subject: { kind: 'feature', featureId: feature.id },
      role: 'dimension',
      content: {
        mode: 'derived',
        template: 'feature.dimensions',
        bindings: { feature: { ref: `feature:${feature.id}` } },
      },
      anchor: { relation: 'inside', keepUpright: true, preferredOrder: ['inside', 'leader'] },
      priority: DEFAULT_PRIORITY.dimension,
      // A building's size is useful but not the point of the plan, so it may
      // give way to boundary dimensions when space is tight.
      visibility: 'optional',
      style: { token: 'label.dimension' },
      provenance: feature.provenance,
    });
  }

  return labels;
}

