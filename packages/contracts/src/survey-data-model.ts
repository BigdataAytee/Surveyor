/**
 * Survey Data Model — the canonical internal representation (Architecture A.3).
 *
 * Everything downstream of the Input Engine reads this and only this. Labels
 * reference into it by id rather than carrying copies of survey values, so a
 * correction to a point propagates to every label that mentions it.
 */

import type { IsoTimestamp, Provenance } from './provenance.js';

export type PointId = string;
export type RingId = string;
export type FeatureId = string;

// ---------------------------------------------------------------------------
// Coordinate reference system
// ---------------------------------------------------------------------------

export type LinearUnit = 'metre' | 'foot' | 'usSurveyFoot';

/** How bearings are expressed. The jurisdiction template picks the display form. */
export type BearingConvention =
  | 'quadrant' // N 87°14'32" E
  | 'azimuth' // 87.2422°, clockwise from north
  | 'grid-azimuth';

/**
 * The CRS/Datum Engine halts the pipeline when this cannot be determined
 * (A.3) — hence no defaults anywhere in this interface.
 */
export interface Crs {
  /** Authority code where one exists, e.g. "EPSG:27700". */
  readonly code?: string;
  readonly name: string;
  readonly datum: string;
  readonly units: LinearUnit;
  readonly bearingConvention: BearingConvention;
  /** Combined grid/ground scale factor, when the plan is on ground distances. */
  readonly combinedScaleFactor?: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A position in the survey CRS. Never a screen or page position. */
export interface Coordinates {
  readonly easting: number;
  readonly northing: number;
  readonly elevation?: number;
}

export interface SurveyPoint {
  readonly id: PointId;
  readonly coordinates: Coordinates;
  readonly provenance: Provenance;
  readonly description?: string;
}

/**
 * `bearing` and `distance` are optional because a segment may be defined either
 * by its endpoints (COGO derives the rest) or by an observed bearing/distance
 * pair (COGO derives the endpoint). Both are populated after the COGO stage.
 */
export interface BoundarySegment {
  readonly from: PointId;
  readonly to: PointId;
  /** Decimal degrees, per the CRS bearing convention. */
  readonly bearing?: number;
  readonly distance?: number;
  readonly curve?: CurveData;
  readonly provenance: Provenance;
}

/** Arc segment parameters. See open sub-question 2 in LABEL_SPECIFICATION.md. */
export interface CurveData {
  readonly radius: number;
  readonly arcLength: number;
  readonly chordLength: number;
  /** Central angle in decimal degrees. */
  readonly delta: number;
  readonly direction: 'clockwise' | 'counter-clockwise';
}

/** A closed traverse. Area is engine-authored, never supplied. */
export interface BoundaryRing {
  readonly id: RingId;
  readonly segments: readonly BoundarySegment[];
  readonly closed: boolean;
  /** In squared CRS units; populated by the COGO engine. */
  readonly area?: number;
}

export type FeatureKind =
  | 'building'
  | 'road'
  | 'fence'
  | 'access'
  | 'water'
  | 'vegetation'
  | 'easement'
  | 'other';

export interface SiteFeature {
  readonly id: FeatureId;
  readonly type: FeatureKind;
  readonly geometry: FeatureGeometry;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly provenance: Provenance;
}

export type FeatureGeometry =
  | { readonly kind: 'polygon'; readonly vertices: readonly Coordinates[] }
  | { readonly kind: 'polyline'; readonly vertices: readonly Coordinates[] }
  | { readonly kind: 'point'; readonly at: Coordinates };

export interface SurveyNote {
  readonly id: string;
  readonly text: string;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface SurveyMetadata {
  readonly jobNumber?: string;
  readonly client?: string;
  readonly date?: IsoTimestamp;
  readonly surveyor?: string;
  /** Selects the Plan Composer template. A parameter, never assumed (A.1 §5). */
  readonly jurisdiction: string;
  readonly siteAddress?: string;
}

export interface SurveyDataModel {
  readonly metadata: SurveyMetadata;
  readonly crs: Crs;
  readonly points: readonly SurveyPoint[];
  readonly boundary: readonly BoundaryRing[];
  readonly siteFeatures: readonly SiteFeature[];
  readonly notes: readonly SurveyNote[];
}
