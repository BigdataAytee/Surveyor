/**
 * CRS / Datum Engine (Architecture A.3).
 *
 * Runs before any COGO calculation: normalizes units, formats and parses
 * bearings per convention, and converts grid <-> ground distances where a
 * scale factor applies.
 *
 * A.3 is explicit that when the CRS/datum cannot be determined the pipeline
 * halts and asks rather than defaulting, so `resolveCrs` returns a halt
 * instead of a guess. There is no fallback CRS constant anywhere in this file.
 */

import type { BearingConvention, Crs, LinearUnit } from '@surveyor/contracts';

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Metres per one unit. The US survey foot is 1200/3937 exactly. */
const METRES_PER_UNIT: Readonly<Record<LinearUnit, number>> = {
  metre: 1,
  foot: 0.3048,
  usSurveyFoot: 1200 / 3937,
};

export const UNIT_ABBREVIATION: Readonly<Record<LinearUnit, string>> = {
  metre: 'm',
  foot: 'ft',
  usSurveyFoot: 'ft',
};

export function toMetres(value: number, unit: LinearUnit): number {
  return value * METRES_PER_UNIT[unit];
}

export function fromMetres(metres: number, unit: LinearUnit): number {
  return metres / METRES_PER_UNIT[unit];
}

export function convertLength(
  value: number,
  from: LinearUnit,
  to: LinearUnit,
): number {
  if (from === to) return value;
  return fromMetres(toMetres(value, from), to);
}

/** Squared units, for areas. */
export function convertArea(
  value: number,
  from: LinearUnit,
  to: LinearUnit,
): number {
  if (from === to) return value;
  const ratio = METRES_PER_UNIT[from] / METRES_PER_UNIT[to];
  return value * ratio * ratio;
}

// ---------------------------------------------------------------------------
// Grid <-> ground
// ---------------------------------------------------------------------------

/**
 * Grid distance = ground distance x combined scale factor.
 *
 * When no factor is supplied the two are identical and these are no-ops — that
 * is a legitimate configuration (a local/assumed grid), not a missing value.
 */
export function groundToGrid(distance: number, crs: Crs): number {
  return distance * (crs.combinedScaleFactor ?? 1);
}

export function gridToGround(distance: number, crs: Crs): number {
  return distance / (crs.combinedScaleFactor ?? 1);
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

export const DEG_PER_RAD = 180 / Math.PI;
export const RAD_PER_DEG = Math.PI / 180;

/** Wrap to [0, 360). */
export function normalizeAzimuth(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export interface Dms {
  readonly degrees: number;
  readonly minutes: number;
  readonly seconds: number;
}

/**
 * Split decimal degrees into D/M/S, carrying rounding upward so a value that
 * rounds to 60 seconds becomes the next minute rather than rendering as 59'60".
 */
export function toDms(decimalDegrees: number, secondsPrecision = 0): Dms {
  const total = Math.abs(decimalDegrees);
  let degrees = Math.floor(total);
  let minutes = Math.floor((total - degrees) * 60);
  let seconds = round((total - degrees - minutes / 60) * 3600, secondsPrecision);

  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }
  return { degrees, minutes, seconds };
}

export function fromDms(dms: Dms): number {
  return dms.degrees + dms.minutes / 60 + dms.seconds / 3600;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function pad(value: number, precision: number): string {
  const fixed = value.toFixed(precision);
  const [whole = '0', fraction] = fixed.split('.');
  const padded = whole.padStart(2, '0');
  return fraction === undefined ? padded : `${padded}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Bearings
// ---------------------------------------------------------------------------

export interface QuadrantBearing {
  readonly ns: 'N' | 'S';
  readonly ew: 'E' | 'W';
  /** Angle from the north-south meridian, 0-90 degrees. */
  readonly angle: number;
}

/** Azimuth (clockwise from north) to the surveyor's quadrant form. */
export function azimuthToQuadrant(azimuth: number): QuadrantBearing {
  const a = normalizeAzimuth(azimuth);
  if (a <= 90) return { ns: 'N', ew: 'E', angle: a };
  if (a <= 180) return { ns: 'S', ew: 'E', angle: 180 - a };
  if (a <= 270) return { ns: 'S', ew: 'W', angle: a - 180 };
  return { ns: 'N', ew: 'W', angle: 360 - a };
}

export function quadrantToAzimuth(q: QuadrantBearing): number {
  if (q.ns === 'N' && q.ew === 'E') return normalizeAzimuth(q.angle);
  if (q.ns === 'S' && q.ew === 'E') return normalizeAzimuth(180 - q.angle);
  if (q.ns === 'S' && q.ew === 'W') return normalizeAzimuth(180 + q.angle);
  return normalizeAzimuth(360 - q.angle);
}

export interface BearingFormatOptions {
  /** Decimal places on seconds (quadrant) or on degrees (azimuth). */
  readonly precision?: number;
}

/**
 * Render a bearing in the CRS's convention. The Plan Composer's jurisdiction
 * template chooses the convention and precision; label text is never hand-built.
 */
/**
 * A plain angle in degrees, minutes and seconds — `92°14'32"`.
 *
 * Distinct from `formatBearing`, which formats a *direction* and so carries a
 * quadrant. An internal angle has no direction; printing one as `N 92° E`
 * would be nonsense on the plan.
 */
export function formatAngle(degrees: number, precision = 0): string {
  const dms = toDms(Math.abs(degrees), precision);
  const sign = degrees < 0 ? '-' : '';
  return `${sign}${dms.degrees}°${pad(dms.minutes, 0)}'${pad(dms.seconds, precision)}"`;
}

export function formatBearing(
  azimuth: number,
  convention: BearingConvention,
  options: BearingFormatOptions = {},
): string {
  const precision = options.precision ?? (convention === 'quadrant' ? 0 : 4);

  if (convention === 'quadrant') {
    const q = azimuthToQuadrant(azimuth);
    const { degrees, minutes, seconds } = toDms(q.angle, precision);
    return `${q.ns} ${degrees}°${pad(minutes, 0)}'${pad(seconds, precision)}" ${q.ew}`;
  }
  return `${normalizeAzimuth(azimuth).toFixed(precision)}°`;
}

const QUADRANT_PATTERN =
  /^([NS])\s*(\d+(?:\.\d+)?)\s*(?:°|d|deg)?\s*(?:(\d+(?:\.\d+)?)\s*(?:'|m|min)?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''|s|sec)?)?\s*([EW])$/i;

const AZIMUTH_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(?:°|d|deg)?\s*(?:(\d+(?:\.\d+)?)\s*(?:'|m|min)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''|s|sec)?)?)?$/i;

/**
 * Parse user- or OCR-supplied bearing text into an azimuth.
 *
 * Returns null rather than a best guess: an unparseable bearing is a question
 * for the user (A.1 §2), not something to approximate.
 */
export function parseBearing(input: string): number | null {
  const text = input.trim().replace(/\s+/g, ' ');
  if (text.length === 0) return null;

  const quadrant = QUADRANT_PATTERN.exec(text);
  if (quadrant) {
    const [, ns, d, m, s, ew] = quadrant;
    const angle = fromDms({
      degrees: Number(d),
      minutes: m === undefined ? 0 : Number(m),
      seconds: s === undefined ? 0 : Number(s),
    });
    if (angle > 90) return null;
    return quadrantToAzimuth({
      ns: ns!.toUpperCase() as 'N' | 'S',
      ew: ew!.toUpperCase() as 'E' | 'W',
      angle,
    });
  }

  const azimuth = AZIMUTH_PATTERN.exec(text);
  if (azimuth) {
    const [, d, m, s] = azimuth;
    const value = fromDms({
      degrees: Number(d),
      minutes: m === undefined ? 0 : Number(m),
      seconds: s === undefined ? 0 : Number(s),
    });
    if (value >= 360) return null;
    return normalizeAzimuth(value);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Resolution — halt rather than default
// ---------------------------------------------------------------------------

export type CrsResolution =
  | { readonly kind: 'resolved'; readonly crs: Crs }
  /**
   * The pipeline stops here. `question` is novice-facing copy shown by the UI
   * (Part C row 4: "novice-friendly prompt, not a raw error").
   */
  | {
      readonly kind: 'halt';
      readonly question: string;
      readonly missing: readonly string[];
    };

/**
 * A small set of well-known systems, offered as *choices* to the user. This is
 * a lookup for a code the user supplied — never an inference from coordinates.
 *
 * The Nigerian systems come first because they are what this tool is used for.
 * All five sit on the **Minna** datum (Clarke 1880 (RGS) ellipsoid), which is
 * the national geodetic datum: UTM for the two zones covering most of the
 * country, and the three national belts that cadastral plans are commonly
 * computed on. They are separate systems, not variants — a coordinate from one
 * is metres out of place in another — so which one a survey was measured in is
 * something the surveyor states rather than something this app guesses.
 */
export const KNOWN_CRS: Readonly<Record<string, Crs>> = {
  'EPSG:26331': {
    code: 'EPSG:26331',
    name: 'Minna / UTM zone 31N',
    datum: 'Minna',
    units: 'metre',
    // Whole-circle bearings, which is what Nigerian plans carry.
    bearingConvention: 'azimuth',
  },
  'EPSG:26332': {
    code: 'EPSG:26332',
    name: 'Minna / UTM zone 32N',
    datum: 'Minna',
    units: 'metre',
    bearingConvention: 'azimuth',
  },
  'EPSG:26391': {
    code: 'EPSG:26391',
    name: 'Minna / Nigeria West Belt',
    datum: 'Minna',
    units: 'metre',
    bearingConvention: 'azimuth',
  },
  'EPSG:26392': {
    code: 'EPSG:26392',
    name: 'Minna / Nigeria Mid Belt',
    datum: 'Minna',
    units: 'metre',
    bearingConvention: 'azimuth',
  },
  'EPSG:26393': {
    code: 'EPSG:26393',
    name: 'Minna / Nigeria East Belt',
    datum: 'Minna',
    units: 'metre',
    bearingConvention: 'azimuth',
  },
  'EPSG:27700': {
    code: 'EPSG:27700',
    name: 'OSGB36 / British National Grid',
    datum: 'OSGB36',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
  'EPSG:2193': {
    code: 'EPSG:2193',
    name: 'NZGD2000 / New Zealand Transverse Mercator',
    datum: 'NZGD2000',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
  'EPSG:28356': {
    code: 'EPSG:28356',
    name: 'GDA94 / MGA zone 56',
    datum: 'GDA94',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
  'EPSG:32633': {
    code: 'EPSG:32633',
    name: 'WGS 84 / UTM zone 33N',
    datum: 'WGS 84',
    units: 'metre',
    bearingConvention: 'azimuth',
  },
};

/**
 * What a new plan is drawn in unless the surveyor says otherwise.
 *
 * A default is not a guess about a particular survey — the pipeline still
 * halts rather than infer a CRS from coordinates — it is what the blank sheet
 * starts on, and it should be the system the person opening this app actually
 * works in.
 *
 * Note that a scale factor is deliberately absent. UTM's is 0.9996 only on the
 * central meridian and grows to roughly 1.0004 at the edge of a zone, and the
 * combined factor also depends on height above the ellipsoid. There is no one
 * correct constant, so distances are treated as grid distances until a
 * surveyor supplies the factor for their site.
 */
export const DEFAULT_CRS_CODE = 'EPSG:26331';

export const DEFAULT_CRS: Crs = KNOWN_CRS[DEFAULT_CRS_CODE]!;

export interface PartialCrs {
  readonly code?: string;
  readonly name?: string;
  readonly datum?: string;
  readonly units?: LinearUnit;
  readonly bearingConvention?: BearingConvention;
  readonly combinedScaleFactor?: number;
}

/**
 * Resolve what the user supplied into a usable CRS, or halt with a plain
 * question naming exactly what is missing.
 */
export function resolveCrs(input: PartialCrs | undefined): CrsResolution {
  if (!input) {
    return {
      kind: 'halt',
      question:
        'Which coordinate system was this survey measured in? Your positions ' +
        'need a reference before the boundary can be calculated.',
      missing: ['code', 'datum', 'units'],
    };
  }

  if (input.code) {
    const known = KNOWN_CRS[input.code];
    if (known) {
      return {
        kind: 'resolved',
        crs:
          input.combinedScaleFactor === undefined
            ? known
            : { ...known, combinedScaleFactor: input.combinedScaleFactor },
      };
    }
  }

  const missing: string[] = [];
  if (!input.datum) missing.push('datum');
  if (!input.units) missing.push('units');
  if (!input.bearingConvention) missing.push('bearingConvention');

  if (missing.length > 0) {
    return {
      kind: 'halt',
      question:
        'I need a little more about the coordinate system before I can ' +
        `calculate anything: ${missing.join(', ')}.`,
      missing,
    };
  }

  const crs: Crs = {
    ...(input.code === undefined ? {} : { code: input.code }),
    name: input.name ?? input.code ?? 'Local grid',
    datum: input.datum!,
    units: input.units!,
    bearingConvention: input.bearingConvention!,
    ...(input.combinedScaleFactor === undefined
      ? {}
      : { combinedScaleFactor: input.combinedScaleFactor }),
  };
  return { kind: 'resolved', crs };
}
