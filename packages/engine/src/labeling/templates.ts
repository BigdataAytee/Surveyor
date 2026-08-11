/**
 * Template registry — the renderer for `LabelContent` in `derived` mode.
 *
 * This file is where invariant I2 of the LabelSpecification contract is cashed
 * out. The AI names a template and binds references; the text is produced here,
 * from the Survey Data Model plus the jurisdiction's formatting rules. No
 * survey value is ever rendered from a string the AI supplied.
 *
 * Reference grammar (the string inside a ValueRef):
 *
 *   point:PT1              a survey point
 *   segment:PT1>PT2        a boundary segment, by its endpoints
 *   ring:ring_1            a closed boundary
 *   feature:bld_1          a site feature
 *   feature:bld_1#name     one attribute of a site feature
 *
 * A ref that does not resolve produces a render failure naming it, never a
 * blank or a placeholder.
 */

import type {
  Crs,
  LabelContent,
  SiteFeature,
  SurveyDataModel,
  SurveyPoint,
  TemplateId,
  ValueRef,
} from '@surveyor/contracts';

import {
  boundsOf,
  distanceBetween,
  type ResolvedRing,
  type ResolvedSegment,
} from '../cogo.js';
import { convertArea, formatBearing, UNIT_ABBREVIATION } from '../crs.js';

// ---------------------------------------------------------------------------
// Context and formatting
// ---------------------------------------------------------------------------

/** Number formatting the jurisdiction template controls. */
export interface FormatRules {
  readonly distanceDecimals: number;
  readonly areaDecimals: number;
  readonly coordinateDecimals: number;
  /** Decimal places on bearing seconds. */
  readonly bearingPrecision: number;
  /** Show hectares/acres alongside square units above this area. */
  readonly largeAreaThreshold: number;
}

export const DEFAULT_FORMAT_RULES: FormatRules = {
  distanceDecimals: 2,
  areaDecimals: 0,
  coordinateDecimals: 2,
  bearingPrecision: 0,
  largeAreaThreshold: 5000,
};

export interface LabelContext {
  readonly model: SurveyDataModel;
  readonly rings: readonly ResolvedRing[];
  readonly format: FormatRules;
}

export function contextFor(
  model: SurveyDataModel,
  rings: readonly ResolvedRing[],
  format: FormatRules = DEFAULT_FORMAT_RULES,
): LabelContext {
  return { model, rings, format };
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

export type Resolved =
  | { readonly kind: 'point'; readonly point: SurveyPoint }
  | {
      readonly kind: 'segment';
      readonly segment: ResolvedSegment;
      readonly ring: ResolvedRing;
    }
  | { readonly kind: 'ring'; readonly ring: ResolvedRing }
  | { readonly kind: 'feature'; readonly feature: SiteFeature }
  | { readonly kind: 'attribute'; readonly value: string };

export function resolveRef(ref: ValueRef, ctx: LabelContext): Resolved | null {
  const [scheme, rest] = splitOnce(ref.ref, ':');
  if (rest === null) return null;

  switch (scheme) {
    case 'point': {
      const point = ctx.model.points.find((p) => p.id === rest);
      return point ? { kind: 'point', point } : null;
    }
    case 'segment': {
      const [from, to] = splitOnce(rest, '>');
      if (to === null) return null;
      for (const ring of ctx.rings) {
        const segment = ring.segments.find((s) => s.from === from && s.to === to);
        if (segment) return { kind: 'segment', segment, ring };
      }
      return null;
    }
    case 'ring': {
      const ring = ctx.rings.find((r) => r.ringId === rest);
      return ring ? { kind: 'ring', ring } : null;
    }
    case 'feature': {
      const [id, attribute] = splitOnce(rest, '#');
      const feature = ctx.model.siteFeatures.find((f) => f.id === id);
      if (!feature) return null;
      if (attribute === null) return { kind: 'feature', feature };
      const value = feature.attributes[attribute];
      return value === undefined
        ? null
        : { kind: 'attribute', value: String(value) };
    }
    default:
      return null;
  }
}

function splitOnce(text: string, separator: string): [string, string | null] {
  const index = text.indexOf(separator);
  if (index === -1) return [text, null];
  return [text.slice(0, index), text.slice(index + separator.length)];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface Template {
  readonly id: TemplateId;
  /** Novice-facing description, also used by the AI to choose a template. */
  readonly description: string;
  readonly bindings: readonly string[];
  readonly render: (
    resolved: Readonly<Record<string, Resolved>>,
    ctx: LabelContext,
  ) => string | null;
}

function distance(value: number, ctx: LabelContext): string {
  const unit = UNIT_ABBREVIATION[ctx.model.crs.units];
  return `${value.toFixed(ctx.format.distanceDecimals)} ${unit}`;
}

function bearing(value: number, crs: Crs, ctx: LabelContext): string {
  return formatBearing(value, crs.bearingConvention, {
    precision: ctx.format.bearingPrecision,
  });
}

function area(value: number, ctx: LabelContext): string {
  const unit = UNIT_ABBREVIATION[ctx.model.crs.units];
  const primary = `${value.toFixed(ctx.format.areaDecimals)} ${unit}²`;
  if (value < ctx.format.largeAreaThreshold) return primary;

  // Large parcels are quoted in the customary big-area unit as well: hectares
  // for metric jurisdictions, acres for imperial ones.
  if (ctx.model.crs.units === 'metre') {
    return `${primary}  (${(value / 10000).toFixed(3)} ha)`;
  }
  const squareMetres = convertArea(value, ctx.model.crs.units, 'metre');
  return `${primary}  (${(squareMetres / 4046.8564224).toFixed(3)} ac)`;
}

const TEMPLATES: readonly Template[] = [
  {
    /**
     * A spot height, e.g. `45.20`.
     *
     * Read off the feature's elevation attribute rather than written into a
     * label by hand, so a level that is corrected on the data sheet is
     * corrected on the plan — which is the whole reason labels are rendered
     * from the model rather than typed.
     */
    id: 'feature.level',
    description: 'A measured level at a point',
    bindings: ['feature'],
    render: (r, ctx) => {
      if (r.feature?.kind !== 'feature') return null;
      const level = r.feature.feature.attributes.elevation;
      if (typeof level !== 'number' || !Number.isFinite(level)) return null;
      return level.toFixed(ctx.format.distanceDecimals);
    },
  },
  {
    id: 'feature.levelWithName',
    description: 'A benchmark: its name and its level',
    bindings: ['feature'],
    render: (r, ctx) => {
      if (r.feature?.kind !== 'feature') return null;
      const { attributes } = r.feature.feature;
      const level = attributes.elevation;
      if (typeof level !== 'number' || !Number.isFinite(level)) return null;
      const name = attributes.name === undefined ? 'BM' : String(attributes.name);
      return `${name}  ${level.toFixed(ctx.format.distanceDecimals)}`;
    },
  },
  {
    id: 'feature.radius',
    description: 'The radius of a circular feature',
    bindings: ['feature'],
    render: (r, ctx) => {
      if (r.feature?.kind !== 'feature') return null;
      const geometry = r.feature.feature.geometry;
      if (geometry.kind !== 'circle' && geometry.kind !== 'arc') return null;
      return `R ${distance(geometry.radius, ctx)}`;
    },
  },
  {
    /**
     * "(proposed)" and nothing at all for existing.
     *
     * A plan that shows both has to say which is which, and saying it only
     * where it differs from the default keeps an existing-conditions drawing
     * from being covered in the word "existing".
     */
    id: 'feature.status',
    description: 'Whether a feature is existing or proposed',
    bindings: ['feature'],
    render: (r) => {
      if (r.feature?.kind !== 'feature') return null;
      const status = r.feature.feature.status;
      return status === undefined || status === 'existing' ? null : `(${status})`;
    },
  },
  {
    id: 'point.id',
    description: 'The point name, e.g. PT1',
    bindings: ['point'],
    render: (r) => (r.point?.kind === 'point' ? r.point.point.id : null),
  },
  {
    id: 'point.coordinate',
    description: 'Easting and northing of a point',
    bindings: ['point'],
    render: (r, ctx) => {
      if (r.point?.kind !== 'point') return null;
      const { easting, northing } = r.point.point.coordinates;
      const d = ctx.format.coordinateDecimals;
      return `E ${easting.toFixed(d)}   N ${northing.toFixed(d)}`;
    },
  },
  {
    id: 'segment.bearingDistance',
    description: 'Bearing and distance along a boundary line',
    bindings: ['segment'],
    render: (r, ctx) => {
      if (r.segment?.kind !== 'segment') return null;
      const s = r.segment.segment;
      return `${bearing(s.bearing, ctx.model.crs, ctx)}   ${distance(s.distance, ctx)}`;
    },
  },
  {
    id: 'segment.distance',
    description: 'Length of a boundary line',
    bindings: ['segment'],
    render: (r, ctx) =>
      r.segment?.kind === 'segment'
        ? distance(r.segment.segment.distance, ctx)
        : null,
  },
  {
    id: 'segment.bearing',
    description: 'Bearing of a boundary line',
    bindings: ['segment'],
    render: (r, ctx) =>
      r.segment?.kind === 'segment'
        ? bearing(r.segment.segment.bearing, ctx.model.crs, ctx)
        : null,
  },
  {
    id: 'segment.curveData',
    description: 'Radius, arc length and central angle of a curved boundary',
    bindings: ['segment'],
    render: (r, ctx) => {
      if (r.segment?.kind !== 'segment') return null;
      const curve = r.segment.segment.curve;
      if (!curve) return null;
      return (
        `R=${distance(curve.radius, ctx)}  ` +
        `L=${distance(curve.arcLength, ctx)}  ` +
        `Δ=${formatBearing(curve.delta, 'azimuth', { precision: 4 })}`
      );
    },
  },
  {
    id: 'ring.area',
    description: 'Enclosed area of a boundary',
    bindings: ['ring'],
    render: (r, ctx) =>
      r.ring?.kind === 'ring' ? area(r.ring.ring.area, ctx) : null,
  },
  {
    id: 'feature.name',
    description: 'The name attribute of a site feature',
    bindings: ['feature'],
    render: (r) => {
      if (r.feature?.kind === 'attribute') return r.feature.value;
      if (r.feature?.kind !== 'feature') return null;
      const name = r.feature.feature.attributes.name;
      return name === undefined ? null : String(name);
    },
  },
  {
    id: 'feature.dimensions',
    description: 'Width and depth of a rectangular feature',
    bindings: ['feature'],
    render: (r, ctx) => {
      if (r.feature?.kind !== 'feature') return null;
      const geometry = r.feature.feature.geometry;
      if (geometry.kind !== 'polygon' || geometry.vertices.length < 3) return null;

      // For a rectangle the two edges meeting at the first corner are the
      // dimensions; for anything else the bounding box is the honest summary.
      const [a, b, c] = geometry.vertices;
      if (geometry.vertices.length === 4 && a && b && c) {
        return `${distance(distanceBetween(a, b), ctx)} × ${distance(
          distanceBetween(b, c),
          ctx,
        )}`;
      }
      const bounds = boundsOf(geometry.vertices);
      return `${distance(bounds.max.easting - bounds.min.easting, ctx)} × ${distance(
        bounds.max.northing - bounds.min.northing,
        ctx,
      )}`;
    },
  },
];

export const TEMPLATE_REGISTRY: ReadonlyMap<TemplateId, Template> = new Map(
  TEMPLATES.map((t) => [t.id, t]),
);

/** The templates the AI is allowed to reference, with their descriptions. */
export function availableTemplates(): readonly Template[] {
  return TEMPLATES;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type RenderResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export function renderContent(
  content: LabelContent,
  ctx: LabelContext,
): RenderResult {
  if (content.mode === 'literal') {
    return { ok: true, text: content.text };
  }

  const template = TEMPLATE_REGISTRY.get(content.template);
  if (!template) {
    return {
      ok: false,
      reason: `Unknown label template "${content.template}".`,
    };
  }

  const resolved: Record<string, Resolved> = {};
  for (const name of template.bindings) {
    const ref = content.bindings[name];
    if (!ref) {
      return {
        ok: false,
        reason: `Template "${template.id}" needs a "${name}" binding.`,
      };
    }
    const value = resolveRef(ref, ctx);
    if (!value) {
      return {
        ok: false,
        reason: `Reference "${ref.ref}" does not match anything in the survey.`,
      };
    }
    resolved[name] = value;
  }

  const text = template.render(resolved, ctx);
  if (text === null || text.length === 0) {
    return {
      ok: false,
      reason: `Template "${template.id}" had nothing to render from the survey data.`,
    };
  }
  return { ok: true, text };
}
