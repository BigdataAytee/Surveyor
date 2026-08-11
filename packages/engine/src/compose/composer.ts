/**
 * Plan Composer (Architecture A.3).
 *
 * Applies the jurisdiction template and assembles the sheet: scale, drawing
 * frame, title block, legend, north arrow, scale bar and notes.
 *
 * This is also where the export gate from LABEL_SPECIFICATION.md §6 is
 * enforced. Composition is the last point at which a plan is still a data
 * structure, so it is the right place to refuse one that is not ready.
 */

import type {
  Coordinates,
  LabelSpecification,
  PlacedLabel,
  PlanPoint,
  SurveyDataModel,
  ValidationReport,
} from '@surveyor/contracts';
import { labelsBlockingExport } from '@surveyor/contracts';

import { boundsOf, type ResolvedRing } from '../cogo.js';
import { UNIT_ABBREVIATION } from '../crs.js';
import type { Drawing, PointSymbol, StrokeStyle } from '../drawing.js';
import {
  contextFor,
  renderContent,
  type FormatRules,
} from '../labeling/templates.js';
import {
  placeLabels,
  worldUnitsPerMm,
  type PlacementOptions,
} from '../labeling/placement.js';
import {
  sheetDimensions,
  STANDARD_SCALES,
  templateFor,
  type JurisdictionTemplate,
  type Orientation,
  type SheetId,
} from './jurisdiction.js';

// ---------------------------------------------------------------------------
// Sheet geometry
// ---------------------------------------------------------------------------

export interface Rect {
  readonly xMm: number;
  readonly yMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** Sheet coordinates: millimetres from the top-left corner, y increasing down. */
export interface SheetPoint {
  readonly xMm: number;
  readonly yMm: number;
}

export interface PlanTransform {
  readonly scaleDenominator: number;
  readonly worldPerMm: number;
  readonly worldCentre: Coordinates;
  readonly frame: Rect;
}

/**
 * Survey coordinates to sheet millimetres. North is up, so the northing axis is
 * flipped: sheet y grows downward, which is what both SVG and PDF expect.
 */
export function projectToSheet(
  world: Coordinates | PlanPoint,
  transform: PlanTransform,
): SheetPoint {
  const easting = 'easting' in world ? world.easting : world.x;
  const northing = 'easting' in world ? world.northing : world.y;

  return {
    xMm:
      transform.frame.xMm +
      transform.frame.widthMm / 2 +
      (easting - transform.worldCentre.easting) / transform.worldPerMm,
    yMm:
      transform.frame.yMm +
      transform.frame.heightMm / 2 -
      (northing - transform.worldCentre.northing) / transform.worldPerMm,
  };
}

// ---------------------------------------------------------------------------
// Composed plan
// ---------------------------------------------------------------------------

export interface TitleBlockEntry {
  readonly label: string;
  readonly value: string;
  /** True when the jurisdiction requires this field and it is still empty. */
  readonly missing: boolean;
}

export interface LegendEntry {
  /** Set when the entry is a point symbol rather than a line style. */
  readonly symbol?: PointSymbol;
  readonly style: StrokeStyle;
  readonly description: string;
}

export interface ComposedPlan {
  readonly sheet: {
    readonly id: SheetId;
    readonly orientation: Orientation;
    readonly widthMm: number;
    readonly heightMm: number;
  };
  readonly transform: PlanTransform;
  readonly frame: Rect;
  readonly titleBlockArea: Rect;
  readonly drawing: Drawing;
  readonly labels: readonly PlacedLabel[];
  readonly titleBlock: readonly TitleBlockEntry[];
  readonly legend: readonly LegendEntry[];
  readonly notes: readonly string[];
  readonly northArrow: { readonly at: SheetPoint; readonly sizeMm: number };
  readonly scaleBar: {
    readonly at: SheetPoint;
    readonly lengthMm: number;
    readonly label: string;
  };
  readonly jurisdiction: JurisdictionTemplate;
  readonly template: { readonly substituted: boolean };
}

export interface ComposeInput {
  readonly model: SurveyDataModel;
  readonly rings: readonly ResolvedRing[];
  readonly drawing: Drawing;
  readonly specs: readonly LabelSpecification[];
  readonly validation?: ValidationReport;
  /** Force a sheet size or scale; otherwise the composer chooses. */
  readonly sheet?: SheetId;
  readonly orientation?: Orientation;
  readonly scaleDenominator?: number;
  readonly plotDate?: string;
}

export type ComposeResult =
  | { readonly ok: true; readonly plan: ComposedPlan; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: 'unconfirmed-labels' | 'validation-failed' | 'empty-drawing';
      readonly message: string;
      readonly blocking: readonly LabelSpecification[];
    };

const MARGIN_MM = 12;
const TITLE_BLOCK_HEIGHT_MM = 42;
const TITLE_BLOCK_WIDTH_MM = 66;

export function composePlan(input: ComposeInput): ComposeResult {
  // --- Export gate (LABEL_SPECIFICATION.md §6) ---------------------------
  //
  // Composition is refused, not merely warned about, while any label is still
  // an unconfirmed AI suggestion. The blocking labels are named so the UI can
  // send the user straight to the trust loop.
  const blocking = labelsBlockingExport(input.specs);
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: 'unconfirmed-labels',
      message:
        blocking.length === 1
          ? 'One suggestion still needs your confirmation before the plan can be produced.'
          : `${blocking.length} suggestions still need your confirmation before the plan can be produced.`,
      blocking,
    };
  }

  if (input.validation && input.validation.status === 'error') {
    return {
      ok: false,
      reason: 'validation-failed',
      message:
        'The drawing has errors that need resolving before a plan can be produced.',
      blocking: [],
    };
  }

  const worldBounds = drawingBounds(input);
  if (!worldBounds) {
    return {
      ok: false,
      reason: 'empty-drawing',
      message: 'There is nothing to draw yet — add a boundary to get started.',
      blocking: [],
    };
  }

  const { template, substituted } = templateFor(input.model.metadata.jurisdiction);
  const warnings: string[] = [];
  if (substituted) {
    warnings.push(
      `No template for "${input.model.metadata.jurisdiction}", so a generic ` +
        `layout was used. Check the title block before lodging this plan.`,
    );
  }

  const fit = chooseSheetAndScale(worldBounds, template, input);
  if (!fit) {
    return {
      ok: false,
      reason: 'empty-drawing',
      message:
        'The survey does not fit on any available sheet at a standard scale.',
      blocking: [],
    };
  }

  const orientation = fit.orientation;
  const dimensions = sheetDimensions(fit.sheet, orientation);
  const frame: Rect = {
    xMm: MARGIN_MM,
    yMm: MARGIN_MM,
    widthMm: dimensions.widthMm - MARGIN_MM * 2,
    heightMm: dimensions.heightMm - MARGIN_MM * 2,
  };

  const transform: PlanTransform = {
    scaleDenominator: fit.scaleDenominator,
    worldPerMm: worldUnitsPerMm(fit.scaleDenominator, input.model.crs.units),
    worldCentre: {
      easting: (worldBounds.min.easting + worldBounds.max.easting) / 2,
      northing: (worldBounds.min.northing + worldBounds.max.northing) / 2,
    },
    frame: drawingFrame(frame),
  };

  const labels = placeWithTemplate(input, template, transform);

  const titleBlockArea: Rect = {
    xMm: frame.xMm + frame.widthMm - TITLE_BLOCK_WIDTH_MM,
    yMm: frame.yMm + frame.heightMm - TITLE_BLOCK_HEIGHT_MM,
    widthMm: TITLE_BLOCK_WIDTH_MM,
    heightMm: TITLE_BLOCK_HEIGHT_MM,
  };

  const plan: ComposedPlan = {
    sheet: {
      id: fit.sheet,
      orientation,
      widthMm: dimensions.widthMm,
      heightMm: dimensions.heightMm,
    },
    transform,
    frame,
    titleBlockArea,
    drawing: input.drawing,
    labels,
    titleBlock: buildTitleBlock(input, template, transform, fit.sheet),
    legend: template.legendRequired ? buildLegend(input.drawing) : [],
    notes: buildNotes(input, template),
    northArrow: {
      at: { xMm: frame.xMm + frame.widthMm - 16, yMm: frame.yMm + 18 },
      sizeMm: 14,
    },
    scaleBar: {
      at: { xMm: frame.xMm + 6, yMm: frame.yMm + frame.heightMm - 8 },
      lengthMm: 40,
      label: scaleBarLabel(transform, input.model),
    },
    jurisdiction: template,
    template: { substituted },
  };

  for (const label of labels) {
    if (label.outcome === 'dropped' && label.spec.visibility === 'required') {
      warnings.push(
        `"${label.text}" could not be fitted on the sheet at 1:${fit.scaleDenominator}.`,
      );
    }
  }

  return { ok: true, plan, warnings };
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function drawingBounds(
  input: ComposeInput,
): { readonly min: Coordinates; readonly max: Coordinates } | null {
  const coordinates: Coordinates[] = [];
  for (const layer of input.drawing.layers) {
    for (const element of layer.elements) {
      if (element.kind === 'symbol') coordinates.push(element.at);
      else coordinates.push(...element.points);
    }
  }
  if (coordinates.length === 0) return null;

  const bounds = boundsOf(coordinates);
  if (
    bounds.max.easting - bounds.min.easting === 0 &&
    bounds.max.northing - bounds.min.northing === 0
  ) {
    return null;
  }
  return bounds;
}

/** The drawing occupies the frame minus the strip the title block sits in. */
function drawingFrame(frame: Rect): Rect {
  return {
    xMm: frame.xMm,
    yMm: frame.yMm,
    widthMm: frame.widthMm,
    heightMm: frame.heightMm - TITLE_BLOCK_HEIGHT_MM - 4,
  };
}

interface Fit {
  readonly sheet: SheetId;
  readonly orientation: Orientation;
  readonly scaleDenominator: number;
}

/**
 * Smallest sheet at the largest scale that still fits, which is what a
 * draughtsman reaches for: detail first, paper second.
 *
 * Sheet is the outer loop and orientation the innermost, so a wide site is
 * turned sideways on the paper it already fits rather than promoted to the
 * next size up. Fixing the orientation instead printed a broad parcel at 1:500
 * in the middle of an otherwise empty sheet; making scale the outer loop
 * over-corrected, reaching for A3 when a landscape A4 would do.
 */
function chooseSheetAndScale(
  bounds: { min: Coordinates; max: Coordinates },
  template: JurisdictionTemplate,
  input: ComposeInput,
): Fit | null {
  const worldWidth = bounds.max.easting - bounds.min.easting;
  const worldHeight = bounds.max.northing - bounds.min.northing;
  // Leave a tenth of the frame as breathing room so labels near the edge of
  // the survey still have somewhere to sit.
  const padding = 1.1;

  const sheets = input.sheet ? [input.sheet] : template.preferredSheets;
  const scales = input.scaleDenominator
    ? [input.scaleDenominator]
    : STANDARD_SCALES;
  const orientations: readonly Orientation[] = input.orientation
    ? [input.orientation]
    : template.defaultOrientation === 'portrait'
      ? ['portrait', 'landscape']
      : ['landscape', 'portrait'];

  for (const sheet of sheets) {
    for (const scaleDenominator of scales) {
      const perMm = worldUnitsPerMm(scaleDenominator, input.model.crs.units);

      for (const orientation of orientations) {
        const dimensions = sheetDimensions(sheet, orientation);
        const frame = drawingFrame({
          xMm: MARGIN_MM,
          yMm: MARGIN_MM,
          widthMm: dimensions.widthMm - MARGIN_MM * 2,
          heightMm: dimensions.heightMm - MARGIN_MM * 2,
        });

        if (
          (worldWidth * padding) / perMm <= frame.widthMm &&
          (worldHeight * padding) / perMm <= frame.heightMm
        ) {
          return { sheet, orientation, scaleDenominator };
        }
      }
    }
  }
  return null;
}

function placeWithTemplate(
  input: ComposeInput,
  template: JurisdictionTemplate,
  transform: PlanTransform,
): readonly PlacedLabel[] {
  const ctx = contextFor(input.model, input.rings, template.format);

  // The jurisdiction may re-rank roles; the AI proposed a priority, the
  // template has the final say (LABEL_SPECIFICATION.md §3.2).
  const specs = input.specs.map((spec) => {
    const override = template.priorityOverrides?.[spec.role];
    return override === undefined ? spec : { ...spec, priority: override };
  });

  const halfWidth = (transform.frame.widthMm / 2) * transform.worldPerMm;
  const halfHeight = (transform.frame.heightMm / 2) * transform.worldPerMm;

  const options: PlacementOptions = {
    scaleDenominator: transform.scaleDenominator,
    textHeightMm: template.minimumLabelHeightMm,
    clearanceMm: 0.8,
    obstacles: input.drawing.layers
      .flatMap((layer) => layer.elements)
      .flatMap((element) => (element.kind === 'symbol' ? [] : [element.points])),
    // Filled shapes are regions to stay out of, not just outlines to avoid
    // crossing — otherwise a parcel's area label sits inside the house.
    avoidAreas: input.drawing.layers
      .flatMap((layer) => layer.elements)
      .flatMap((element) =>
        element.kind === 'polygon'
          ? [{ ownerId: element.id, vertices: element.points }]
          : [],
      ),
    sheetBounds: {
      min: {
        easting: transform.worldCentre.easting - halfWidth,
        northing: transform.worldCentre.northing - halfHeight,
      },
      max: {
        easting: transform.worldCentre.easting + halfWidth,
        northing: transform.worldCentre.northing + halfHeight,
      },
    },
    sheetAnchor: {
      x: transform.worldCentre.easting - halfWidth,
      y: transform.worldCentre.northing - halfHeight * 0.82,
    },
  };

  return placeLabels({ specs, ctx, options }).labels;
}

// ---------------------------------------------------------------------------
// Title block, legend, notes
// ---------------------------------------------------------------------------

function buildTitleBlock(
  input: ComposeInput,
  template: JurisdictionTemplate,
  transform: PlanTransform,
  sheet: SheetId,
): readonly TitleBlockEntry[] {
  return template.titleBlock.map((field) => {
    const value = titleBlockValue(
      field.source,
      input,
      transform,
      template.format,
      sheet,
    );
    return {
      label: field.label,
      value,
      missing: field.required && value.length === 0,
    };
  });
}

function titleBlockValue(
  source: JurisdictionTemplate['titleBlock'][number]['source'],
  input: ComposeInput,
  transform: PlanTransform,
  format: FormatRules,
  sheet: SheetId,
): string {
  if (source.from === 'blank') return '';

  if (source.from === 'metadata') {
    const metadata = input.model.metadata as unknown as Record<string, unknown>;
    const value = metadata[source.key];
    return value === undefined || value === null ? '' : String(value);
  }

  switch (source.key) {
    case 'scale':
      return `1:${transform.scaleDenominator}`;
    case 'sheetSize':
      return sheet;
    case 'crs':
      return input.model.crs.name;
    case 'plotDate':
      return input.plotDate ?? '';
    case 'area': {
      const ring = input.rings[0];
      if (!ring) return '';
      const rendered = renderContent(
        {
          mode: 'derived',
          template: 'ring.area',
          bindings: { ring: { ref: `ring:${ring.ringId}` } },
        },
        contextFor(input.model, input.rings, format),
      );
      return rendered.ok ? rendered.text : '';
    }
  }
}

/**
 * Every stroke style, described.
 *
 * A complete record rather than a partial one: a style with no entry is a line
 * on a plan that the legend does not explain, and the reviewer has no way to
 * find out what it is. Making it complete means adding a stroke style forces
 * you to say what it means, here, at the moment you add it.
 */
const LEGEND_DESCRIPTIONS: Record<StrokeStyle, string> = {
  boundary: 'Boundary line',
  'boundary-curve': 'Boundary curve',
  building: 'Building',
  road: 'Road / carriageway',
  'road-centreline': 'Road centreline',
  fence: 'Fence',
  access: 'Access',
  water: 'Watercourse',
  vegetation: 'Vegetation',
  easement: 'Easement',
  wall: 'Wall',
  utility: 'Service run',
  annotation: 'Annotation',
  'point-marker': 'Survey point',
};

/**
 * Symbols get legend entries too.
 *
 * A cross on a plan means nothing to a reviewer who has not been told it is a
 * spot height, and symbols were being left out of the legend entirely — so a
 * drawing full of levels arrived with no key to them.
 */
const SYMBOL_DESCRIPTIONS: Partial<Record<PointSymbol, string>> = {
  'boundary-corner': 'Boundary corner',
  'survey-station': 'Survey station',
  'found-marker': 'Found marker',
  level: 'Spot height',
  benchmark: 'Benchmark',
  tree: 'Tree',
  gate: 'Gate',
};

/** Only styles actually used are listed — a legend of absent symbols is noise. */
function buildLegend(drawing: Drawing): readonly LegendEntry[] {
  const styles = new Set<StrokeStyle>();
  const symbols = new Set<PointSymbol>();

  for (const layer of drawing.layers) {
    for (const element of layer.elements) {
      if (element.kind === 'symbol') symbols.add(element.symbol);
      else styles.add(element.style);
    }
  }

  const lines = [...styles]
    .sort()
    .map((style) => ({ style, description: LEGEND_DESCRIPTIONS[style] }));

  const marks = [...symbols]
    .filter((symbol) => SYMBOL_DESCRIPTIONS[symbol] !== undefined)
    .sort()
    .map((symbol) => ({
      style: 'point-marker' as const,
      symbol,
      description: SYMBOL_DESCRIPTIONS[symbol]!,
    }));

  return [...lines, ...marks];
}

function buildNotes(
  input: ComposeInput,
  template: JurisdictionTemplate,
): readonly string[] {
  const authored = input.model.notes.map((note) => note.text);
  // Jurisdiction notes are appended rather than merged, so a user note can
  // never displace a mandatory one.
  return [...authored, ...template.requiredNotes];
}

function scaleBarLabel(
  transform: PlanTransform,
  model: SurveyDataModel,
): string {
  const unit = UNIT_ABBREVIATION[model.crs.units];
  const worldLength = 40 * transform.worldPerMm;
  return `0 — ${worldLength.toFixed(0)} ${unit}`;
}

/** Title block fields the jurisdiction demands that are still empty. */
export function missingTitleBlockFields(
  plan: ComposedPlan,
): readonly TitleBlockEntry[] {
  return plan.titleBlock.filter((entry) => entry.missing);
}
