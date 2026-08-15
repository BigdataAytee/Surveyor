/**
 * The named grids and the named datum transformations.
 *
 * Everything here is a quoted definition, not a derived or fitted one. Each
 * entry names the authority code it comes from so that a surveyor can check it
 * against the register rather than against this code, and each transformation
 * states its accuracy, because a conversion whose error is unknown is a
 * conversion nobody should sign a plan on.
 *
 * Nothing in this file is a default or a fallback. A grid that is not listed
 * is not converted, and a datum with no named transformation to WGS 84 is not
 * converted either — it says so and stops. Guessing a datum shift is the exact
 * failure this module exists to prevent: it produces coordinates that look
 * entirely reasonable and are a hundred metres from the truth.
 */

import { AIRY_1830, CLARKE_1880_RGS, WGS84_ELLIPSOID, type Ellipsoid } from './ellipsoid.js';
import type { HelmertParameters } from './datum.js';
import type { TransverseMercator } from './transverse-mercator.js';

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

/** Degrees, minutes, seconds to decimal degrees — for writing definitions as published. */
const dms = (degrees: number, minutes = 0, seconds = 0): number =>
  degrees + minutes / 60 + seconds / 3600;

/**
 * Projected systems this app can take a coordinate out of.
 *
 * The Nigerian belts share a latitude of origin (4°N) and a scale factor
 * (0.99975) and differ in their central meridian and false easting. Those
 * false eastings are not round numbers because the belts were originally laid
 * out in feet; they are quoted here exactly as the register gives them.
 */
export const PROJECTED_CRS: Readonly<Record<string, TransverseMercator>> = {
  // Minna / UTM zone 31N
  'EPSG:26331': {
    ellipsoid: CLARKE_1880_RGS,
    latitudeOfOrigin: 0,
    centralMeridian: 3,
    scaleFactor: 0.9996,
    falseEasting: 500000,
    falseNorthing: 0,
  },
  // Minna / UTM zone 32N
  'EPSG:26332': {
    ellipsoid: CLARKE_1880_RGS,
    latitudeOfOrigin: 0,
    centralMeridian: 9,
    scaleFactor: 0.9996,
    falseEasting: 500000,
    falseNorthing: 0,
  },
  // Minna / Nigeria West Belt
  'EPSG:26391': {
    ellipsoid: CLARKE_1880_RGS,
    latitudeOfOrigin: 4,
    centralMeridian: dms(4, 30),
    scaleFactor: 0.99975,
    falseEasting: 230738.26,
    falseNorthing: 0,
  },
  // Minna / Nigeria Mid Belt
  'EPSG:26392': {
    ellipsoid: CLARKE_1880_RGS,
    latitudeOfOrigin: 4,
    centralMeridian: dms(8, 30),
    scaleFactor: 0.99975,
    falseEasting: 670553.98,
    falseNorthing: 0,
  },
  // Minna / Nigeria East Belt
  'EPSG:26393': {
    ellipsoid: CLARKE_1880_RGS,
    latitudeOfOrigin: 4,
    centralMeridian: dms(12, 30),
    scaleFactor: 0.99975,
    falseEasting: 1110369.7,
    falseNorthing: 0,
  },
  /*
   * OSGB36 / British National Grid.
   *
   * Present so that a survey on it can be *told* what it is missing rather
   * than lumped in with grids this app has never heard of. It has a projection
   * and no transformation, which is the honest position: going from OSGB36 to
   * WGS 84 properly needs the national grid-shift file, and the seven-parameter
   * approximations to it are good to a couple of metres in some places and much
   * worse in others. That is a decision for someone working in Britain to make
   * deliberately, not one for this app to make on their behalf.
   */
  'EPSG:27700': {
    ellipsoid: AIRY_1830,
    latitudeOfOrigin: 49,
    centralMeridian: -2,
    scaleFactor: 0.9996012717,
    falseEasting: 400000,
    falseNorthing: -100000,
  },
  // WGS 84 / UTM zone 33N — already on WGS 84, so its "shift" is the identity.
  'EPSG:32633': {
    ellipsoid: WGS84_ELLIPSOID,
    latitudeOfOrigin: 0,
    centralMeridian: 15,
    scaleFactor: 0.9996,
    falseEasting: 500000,
    falseNorthing: 0,
  },
};

// ---------------------------------------------------------------------------
// Datum transformations
// ---------------------------------------------------------------------------

export interface DatumTransformation {
  /** The authority's name for this operation, printed wherever it is used. */
  readonly name: string;
  /** The authority code, so it can be looked up rather than taken on trust. */
  readonly code: string;
  readonly from: string;
  readonly to: string;
  readonly sourceEllipsoid: Ellipsoid;
  readonly targetEllipsoid: Ellipsoid;
  readonly parameters: HelmertParameters;
  /**
   * The published accuracy of the operation, metres, one sigma.
   *
   * Carried because it belongs on anything the conversion produces. A position
   * good to a few metres is exactly right for finding a site on a map and
   * exactly wrong for setting a boundary, and the only way anyone can tell the
   * difference is if the number travels with the coordinate.
   */
  readonly accuracyMetres: number;
  /** Where the area of validity is, in words. */
  readonly extent: string;
}

/**
 * Minna to WGS 84, by geocentric translation.
 *
 * The published three-parameter set for Nigeria — EPSG operation
 * "Minna to WGS 84 (1)", code 1310, EPSG method 9603 (geocentric
 * translations). Its stated accuracy is of the order of a few metres, which is
 * what a three-parameter shift across a whole country can be.
 *
 * That accuracy is the reason this app converts a *copy* and never the survey.
 * A few metres is nothing when the job is to show a parcel on a satellite
 * image and everything when the job is a boundary: the Minna coordinates the
 * surveyor measured are the legal record, and they stay untouched. Anyone
 * needing better than this for a real transformation should have local
 * parameters derived from control observed in their area, and can supply them
 * through the `transformation` option on `toWgs84` and `wgs84Copy`.
 */
export const MINNA_TO_WGS84: DatumTransformation = {
  name: 'Minna to WGS 84 (1)',
  code: 'EPSG:1310',
  from: 'Minna',
  to: 'WGS 84',
  sourceEllipsoid: CLARKE_1880_RGS,
  targetEllipsoid: WGS84_ELLIPSOID,
  // Geocentric translation: no rotations, no scale, so the rotation sign
  // convention cannot apply and cannot be got wrong.
  parameters: { dx: -92, dy: -93, dz: 122 },
  accuracyMetres: 3,
  extent: 'Nigeria — onshore and offshore',
};

/**
 * WGS 84 to itself.
 *
 * Present so that a survey already on WGS 84 goes through the same path as
 * every other, rather than being a special case somebody has to remember. Its
 * accuracy is zero because nothing happens.
 */
export const WGS84_IDENTITY: DatumTransformation = {
  name: 'WGS 84 (no transformation required)',
  code: 'none',
  from: 'WGS 84',
  to: 'WGS 84',
  sourceEllipsoid: WGS84_ELLIPSOID,
  targetEllipsoid: WGS84_ELLIPSOID,
  parameters: { dx: 0, dy: 0, dz: 0 },
  accuracyMetres: 0,
  extent: 'Worldwide',
};

/**
 * Which transformation to use for a datum, by the datum's name.
 *
 * Keyed by datum rather than by projected system: the shift is a property of
 * the datum, and Minna / UTM zone 31N and Minna / Nigeria Mid Belt take the
 * same one. A datum absent from this table has no transformation, and that is
 * an answer — not a reason to reach for a similar one.
 */
export const DATUM_TRANSFORMATIONS: Readonly<Record<string, DatumTransformation>> = {
  Minna: MINNA_TO_WGS84,
  'WGS 84': WGS84_IDENTITY,
};
