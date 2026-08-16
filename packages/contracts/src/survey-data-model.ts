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

/**
 * What a thing on the site is.
 *
 * The kind drives how it is drawn, what it is called on the plan, and which
 * legend entry it earns — so it is a closed list rather than free text. Adding
 * one is a deliberate act: the compiler then requires a stroke style and a
 * label template for it, which is what stops a new kind from appearing on a
 * plan as an unexplained grey line.
 */
export type FeatureKind =
  | 'building'
  | 'road'
  | 'driveway'
  | 'fence'
  | 'wall'
  | 'gate'
  | 'access'
  | 'water'
  | 'vegetation'
  | 'tree'
  | 'utility'
  | 'easement'
  /** A spot height: a measured level at a point, carrying its elevation. */
  | 'level'
  /** A benchmark or datum reference the levels are measured from. */
  | 'benchmark'
  /** Free text the surveyor placed on the drawing. */
  | 'annotation'
  | 'other';

/**
 * Whether a feature is there now or is being proposed.
 *
 * A site plan routinely shows both, and confusing them is the kind of error
 * that gets a plan rejected — so it is a field rather than a naming
 * convention in the label.
 */
export type FeatureStatus = 'existing' | 'proposed' | 'removed';

export interface SiteFeature {
  readonly id: FeatureId;
  readonly type: FeatureKind;
  /** Existing unless stated; a plan that does not say is read as existing. */
  readonly status?: FeatureStatus;
  readonly geometry: FeatureGeometry;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly provenance: Provenance;
  /**
   * Additive. How it is drawn, never where it is or what it measures.
   */
  readonly lineStyle?: LineStyle;
}

export type FeatureGeometry =
  | { readonly kind: 'polygon'; readonly vertices: readonly Coordinates[] }
  | { readonly kind: 'polyline'; readonly vertices: readonly Coordinates[] }
  | { readonly kind: 'point'; readonly at: Coordinates }
  /**
   * A true circle, kept as centre and radius rather than as vertices.
   *
   * A tree canopy or a manhole is a circle, and storing it as a tessellated
   * polygon would make its radius something you measure off the drawing
   * instead of something the drawing knows. Tessellation happens at render
   * time, where the number of segments can suit the zoom.
   */
  | { readonly kind: 'circle'; readonly centre: Coordinates; readonly radius: number }
  /** An arc, as centre, radius and the bearings it runs between. */
  | {
      readonly kind: 'arc';
      readonly centre: Coordinates;
      readonly radius: number;
      readonly startBearing: number;
      readonly endBearing: number;
    };

export interface SurveyNote {
  readonly id: string;
  readonly text: string;
  readonly provenance: Provenance;
  /** Additive. Never affects placement — see `TextStyle`. */
  readonly style?: TextStyle;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * How something is drawn, as opposed to what it is.
 *
 * Every field is optional and every absent field means "the default for this
 * kind of object". That matters more than it looks: it is what lets styling be
 * added to a plan drawn before styling existed, and what keeps an unstyled
 * object identical to one that was never offered the choice.
 *
 * Style is presentation and nothing else. It must never reach label placement,
 * geometry, or provenance — a bold dimension is the same dimension, and a red
 * boundary is the same boundary. Anything that reads these to decide *where*
 * something goes has crossed a line this type exists to hold.
 */
export interface TextStyle {
  /** Cap height in millimetres on the sheet. Absent means the plan's default. */
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** CSS colour. Absent means the drawing's ink colour, which follows theme. */
  readonly color?: string;
}

export interface LineStyle {
  readonly color?: string;
  /** Millimetres on the sheet. */
  readonly strokeWidth?: number;
  readonly dashed?: boolean;
}

/**
 * Text the surveyor put on the drawing, anywhere they liked.
 *
 * Distinct from `notes`, which are the plan's numbered notes and print in a
 * block, and from an `annotation` feature, which is a thing on the ground. A
 * text box is neither: it is a remark placed at a position on the sheet, it is
 * free-floating by design, and it is deliberately *not* snapped to the survey
 * grid — an annotation that latched onto a boundary corner would be claiming a
 * relationship to it that the surveyor did not mean.
 */
export interface FreeTextBox {
  readonly id: string;
  readonly text: string;
  /** Where it sits, in survey coordinates, so it stays put as the plan moves. */
  readonly at: Coordinates;
  readonly style?: TextStyle;
  readonly provenance: Provenance;
}

/**
 * The title, the representative fraction and the scale bar, as one object.
 *
 * One object rather than three because they are one statement: this plan, at
 * this scale, and here is the bar to check it against. Splitting them lets a
 * surveyor move the bar away from the fraction it belongs to, or delete one
 * and leave the sheet claiming a scale nothing verifies.
 *
 * A field set here is a field the surveyor has decided. Absent means "read it
 * from the plan" — the title from the metadata, the scale from the extent —
 * and that is also what makes the assistant safe to let near it: it fills in
 * what is absent and never touches what is present.
 */
export interface TitleScaleBlock {
  readonly id: string;
  readonly at: Coordinates;
  readonly showTitle: boolean;
  readonly showRepresentativeFraction: boolean;
  readonly showScaleBar: boolean;
  /** Overrides the site address. Present means the surveyor typed it. */
  readonly title?: string;
  readonly subtitle?: string;
  /** The denominator of 1:N. Present means the surveyor chose the scale. */
  readonly scaleDenominator?: number;
  readonly style?: TextStyle;
  readonly provenance: Provenance;
}

/**
 * A dimension the surveyor placed.
 *
 * Boundary dimensions are automatic — every segment of a ring gets one. This is
 * for everything else a plan has to show and no rule can infer: the setback
 * from the house to the front boundary, the width of a driveway, the distance
 * from a tree to a wall.
 *
 * It stores which two points it measures between and nothing about the answer.
 * A dimension carrying its own value would be a second copy of a survey
 * measurement, free to drift from the first the moment a point is corrected —
 * and a plan whose printed distance disagrees with its own geometry is worse
 * than one with no dimension at all. The value is computed by the COGO engine
 * at draw time, from the same call the boundary dimensions use.
 */
export interface Dimension {
  readonly id: string;
  readonly from: PointId;
  readonly to: PointId;
  /**
   * How far off the measured line the dimension is drawn, in style-token
   * steps rather than millimetres — "just clear of it" has to mean the same
   * at 1:200 and 1:1000, and only the Plan Composer knows the scale.
   */
  readonly offsetSteps?: number;
  /** Whether the bearing prints alongside the distance. */
  readonly showBearing?: boolean;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * One issue of the plan.
 *
 * A drawing that has been reissued has to say so, and say what changed —
 * a reviewer comparing two prints needs to know which is later and why they
 * differ. Revisions are ordered by the list, not by parsing the number, so
 * "A", "1" and "P2" all work.
 */
export interface Revision {
  /** As printed: "A", "1", "P2". */
  readonly code: string;
  readonly date: IsoTimestamp;
  readonly description: string;
  readonly by?: string;
}

export interface SurveyMetadata {
  readonly jobNumber?: string;
  readonly client?: string;
  readonly date?: IsoTimestamp;
  readonly surveyor?: string;
  /** Selects the Plan Composer template. A parameter, never assumed (A.1 §5). */
  readonly jurisdiction: string;
  readonly siteAddress?: string;
  /** Oldest first. The last one is the current issue. */
  readonly revisions?: readonly Revision[];
  /**
   * The area someone else says this parcel is — off a deed, a title, a client's
   * brief — in the square units of the CRS.
   *
   * Kept apart from the area the geometry gives, and never used in place of
   * it. Its whole purpose is to be compared: a stated area and a computed one
   * that disagree is a fact worth surfacing, and an app that silently prefers
   * either has thrown away the only signal that something is wrong.
   */
  readonly statedArea?: number;
}

export interface SurveyDataModel {
  readonly metadata: SurveyMetadata;
  readonly crs: Crs;
  readonly points: readonly SurveyPoint[];
  readonly boundary: readonly BoundaryRing[];
  readonly siteFeatures: readonly SiteFeature[];
  readonly notes: readonly SurveyNote[];
  /** Dimensions the surveyor placed, beyond the automatic boundary ones. */
  readonly dimensions?: readonly Dimension[];
  /** Free text the surveyor placed on the sheet. Optional, so older plans read back unchanged. */
  readonly textBoxes?: readonly FreeTextBox[];
  /** The title, representative fraction and scale bar, if the plan carries them. */
  readonly titleBlock?: TitleScaleBlock;
}
