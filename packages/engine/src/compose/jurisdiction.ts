/**
 * Jurisdiction templates (Architecture A.1 §5, A.3 Plan Composer).
 *
 * "Jurisdiction is a parameter, not an assumption." Everything that varies by
 * where the plan will be lodged lives here: title block fields, mandatory
 * notes, minimum label sizes, closure tolerance, number formatting, and which
 * label roles get promoted.
 *
 * Swapping a template must never require touching the Drawing or Labeling
 * engines, so nothing in this file is imported by them — the flow is one-way,
 * into the composer.
 */

import type { BearingConvention, LabelPriority, LabelRole } from '@surveyor/contracts';

import type { FormatRules } from '../labeling/templates.js';
import { DEFAULT_FORMAT_RULES } from '../labeling/templates.js';
import type { ClosureTolerance } from '../validation.js';
import { DEFAULT_CLOSURE_TOLERANCE } from '../validation.js';

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export type SheetId = 'A4' | 'A3' | 'A2' | 'A1';
export type Orientation = 'portrait' | 'landscape';

export interface SheetSize {
  readonly id: SheetId;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** ISO A series, portrait dimensions. */
export const SHEET_SIZES: Readonly<Record<SheetId, SheetSize>> = {
  A4: { id: 'A4', widthMm: 210, heightMm: 297 },
  A3: { id: 'A3', widthMm: 297, heightMm: 420 },
  A2: { id: 'A2', widthMm: 420, heightMm: 594 },
  A1: { id: 'A1', widthMm: 594, heightMm: 841 },
};

export function sheetDimensions(
  id: SheetId,
  orientation: Orientation,
): { readonly widthMm: number; readonly heightMm: number } {
  const size = SHEET_SIZES[id];
  return orientation === 'portrait'
    ? { widthMm: size.widthMm, heightMm: size.heightMm }
    : { widthMm: size.heightMm, heightMm: size.widthMm };
}

/** Scales a surveyor would actually choose, smallest denominator first. */
export const STANDARD_SCALES: readonly number[] = [
  50, 100, 200, 250, 500, 1000, 1250, 2500, 5000,
];

// ---------------------------------------------------------------------------
// Title block
// ---------------------------------------------------------------------------

/**
 * Where a title block field gets its value. `metadata` reads the Survey Data
 * Model; `computed` is filled by the composer (scale, area, date of plot);
 * `blank` is a ruled line for someone to sign.
 */
export type TitleBlockSource =
  | { readonly from: 'metadata'; readonly key: string }
  | { readonly from: 'computed'; readonly key: ComputedField }
  | { readonly from: 'blank' };

export type ComputedField = 'scale' | 'area' | 'sheetSize' | 'crs' | 'plotDate';

export interface TitleBlockField {
  readonly label: string;
  readonly source: TitleBlockSource;
  /** A field the jurisdiction will not accept a plan without. */
  readonly required: boolean;
}

export interface JurisdictionTemplate {
  readonly id: string;
  readonly name: string;
  readonly titleBlock: readonly TitleBlockField[];
  /** Notes that must appear on every plan lodged in this jurisdiction. */
  readonly requiredNotes: readonly string[];
  readonly minimumLabelHeightMm: number;
  readonly closureTolerance: ClosureTolerance;
  readonly format: FormatRules;
  readonly bearingConvention: BearingConvention;
  readonly legendRequired: boolean;
  readonly preferredSheets: readonly SheetId[];
  readonly defaultOrientation: Orientation;
  /** Re-ranks label roles — see LABEL_SPECIFICATION.md §3.2. */
  readonly priorityOverrides?: Partial<Record<LabelRole, LabelPriority>>;
}

const COMMON_FIELDS: readonly TitleBlockField[] = [
  { label: 'Client', source: { from: 'metadata', key: 'client' }, required: true },
  { label: 'Job number', source: { from: 'metadata', key: 'jobNumber' }, required: true },
  { label: 'Surveyor', source: { from: 'metadata', key: 'surveyor' }, required: true },
  { label: 'Scale', source: { from: 'computed', key: 'scale' }, required: true },
  { label: 'Sheet', source: { from: 'computed', key: 'sheetSize' }, required: true },
  { label: 'Date', source: { from: 'metadata', key: 'date' }, required: true },
];

export const GENERIC_TEMPLATE: JurisdictionTemplate = {
  id: 'generic',
  name: 'Generic site plan',
  titleBlock: [
    { label: 'Site', source: { from: 'metadata', key: 'siteAddress' }, required: true },
    ...COMMON_FIELDS,
    { label: 'Area', source: { from: 'computed', key: 'area' }, required: false },
    { label: 'Coordinate system', source: { from: 'computed', key: 'crs' }, required: true },
  ],
  requiredNotes: [],
  minimumLabelHeightMm: 1.8,
  closureTolerance: DEFAULT_CLOSURE_TOLERANCE,
  format: DEFAULT_FORMAT_RULES,
  bearingConvention: 'quadrant',
  legendRequired: true,
  preferredSheets: ['A4', 'A3', 'A2', 'A1'],
  defaultOrientation: 'landscape',
};

export const UK_TEMPLATE: JurisdictionTemplate = {
  id: 'uk-land-registry',
  name: 'UK — Land Registry compliant plan',
  titleBlock: [
    { label: 'Property', source: { from: 'metadata', key: 'siteAddress' }, required: true },
    ...COMMON_FIELDS,
    { label: 'Area', source: { from: 'computed', key: 'area' }, required: true },
    { label: 'Coordinate system', source: { from: 'computed', key: 'crs' }, required: true },
    { label: 'Signed', source: { from: 'blank' }, required: false },
  ],
  requiredNotes: [
    'Plan prepared for identification purposes. Dimensions in metres.',
    'Reproduced from Ordnance Survey data with permission.',
  ],
  minimumLabelHeightMm: 2,
  closureTolerance: { minimumRatio: 8000, maximumMisclosure: 0.03 },
  format: { ...DEFAULT_FORMAT_RULES, distanceDecimals: 2, areaDecimals: 0 },
  bearingConvention: 'quadrant',
  legendRequired: true,
  preferredSheets: ['A4', 'A3'],
  defaultOrientation: 'portrait',
};

export const US_TEMPLATE: JurisdictionTemplate = {
  id: 'us-generic',
  name: 'US — generic boundary survey',
  titleBlock: [
    { label: 'Property', source: { from: 'metadata', key: 'siteAddress' }, required: true },
    ...COMMON_FIELDS,
    { label: 'Area', source: { from: 'computed', key: 'area' }, required: true },
    { label: 'Basis of bearings', source: { from: 'computed', key: 'crs' }, required: true },
    { label: 'Surveyor’s seal', source: { from: 'blank' }, required: true },
  ],
  requiredNotes: [
    'This survey was prepared without the benefit of a title commitment.',
    'Bearings shown are grid bearings unless noted otherwise.',
  ],
  minimumLabelHeightMm: 2.4,
  closureTolerance: { minimumRatio: 7500, maximumMisclosure: 0.05 },
  format: { ...DEFAULT_FORMAT_RULES, distanceDecimals: 2, coordinateDecimals: 2 },
  bearingConvention: 'quadrant',
  legendRequired: false,
  preferredSheets: ['A3', 'A2'],
  defaultOrientation: 'landscape',
  // A US boundary survey is expected to show corner coordinates on the face,
  // so they are promoted out of the default third tier.
  priorityOverrides: { coordinate: 2 },
};

export const JURISDICTIONS: ReadonlyMap<string, JurisdictionTemplate> = new Map(
  [GENERIC_TEMPLATE, UK_TEMPLATE, US_TEMPLATE].map((t) => [t.id, t]),
);

/**
 * Look up a template. Falls back to the generic one so an unknown jurisdiction
 * still produces a plan — but the caller is told, because a plan drawn to the
 * wrong template is a real problem the user should hear about.
 */
export function templateFor(jurisdiction: string): {
  readonly template: JurisdictionTemplate;
  readonly substituted: boolean;
} {
  const template = JURISDICTIONS.get(jurisdiction);
  return template
    ? { template, substituted: false }
    : { template: GENERIC_TEMPLATE, substituted: true };
}
