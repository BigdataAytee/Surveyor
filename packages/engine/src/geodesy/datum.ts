/**
 * Moving between datums.
 *
 * A datum shift is not a formula applied to latitude and longitude. It is a
 * rigid movement of one ellipsoid relative to another in three-dimensional
 * space, so the position has to be taken out to geocentric Cartesian
 * coordinates, moved, and brought back onto the other ellipsoid. Anything that
 * "adds a bit to the latitude" is an approximation, and this file exists so
 * that no such thing appears anywhere in this app.
 *
 * The transformation itself is Helmert's seven parameters. Three of them —
 * three translations — is the common case for a national datum like Minna, and
 * a three-parameter shift is simply this with the rotations and scale set to
 * zero. Keeping one implementation means the seven-parameter path is exercised
 * by every test of the three-parameter one.
 */

import { constantsOf, DEG, RAD, type Ellipsoid } from './ellipsoid.js';
import type { Geographic } from './transverse-mercator.js';

/**
 * The sign convention for the rotations.
 *
 * These two differ only in the sign of the rotation terms, and mixing them up
 * is one of the classic ways to be wrong by a few metres while every number
 * looks plausible. So the convention is named on every transformation rather
 * than assumed, and a set of parameters with no rotations is unaffected by it
 * — which is why a three-parameter shift is safe to state either way.
 */
export type RotationConvention = 'position-vector' | 'coordinate-frame';

export interface HelmertParameters {
  /** Translations, metres. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  /** Rotations, arc-seconds. Zero for a geocentric translation. */
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  /** Scale difference, parts per million. */
  readonly scalePpm?: number;
  readonly convention?: RotationConvention;
}

export interface Geocentric {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function geographicToGeocentric(
  position: Geographic,
  ellipsoid: Ellipsoid,
): Geocentric {
  const { a, e2 } = constantsOf(ellipsoid);
  const phi = position.latitude * DEG;
  const lambda = position.longitude * DEG;
  const h = position.height ?? 0;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const nu = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);

  return {
    x: (nu + h) * cosPhi * Math.cos(lambda),
    y: (nu + h) * cosPhi * Math.sin(lambda),
    z: (nu * (1 - e2) + h) * sinPhi,
  };
}

/**
 * Back onto an ellipsoid, by iteration.
 *
 * Bowring's closed formula would do at the millimetre level, but this converges
 * to the limit of double precision in a handful of passes and there is no
 * reason to accept a known approximation in the one place where the whole
 * point is not approximating.
 */
export function geocentricToGeographic(
  position: Geocentric,
  ellipsoid: Ellipsoid,
): Geographic {
  const { a, e2 } = constantsOf(ellipsoid);
  const { x, y, z } = position;

  const p = Math.sqrt(x * x + y * y);
  const longitude = Math.atan2(y, x) * RAD;

  // At the poles longitude is undefined and p is zero; the latitude is still
  // well defined and the height is measured straight up the axis.
  if (p < 1e-12) {
    const b = a * Math.sqrt(1 - e2);
    return { latitude: z >= 0 ? 90 : -90, longitude: 0, height: Math.abs(z) - b };
  }

  let phi = Math.atan2(z, p * (1 - e2));
  let nu = a;

  for (let pass = 0; pass < 32; pass += 1) {
    const sinPhi = Math.sin(phi);
    nu = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const next = Math.atan2(z + e2 * nu * sinPhi, p);
    if (Math.abs(next - phi) < 1e-14) {
      phi = next;
      break;
    }
    phi = next;
  }

  const sinPhi = Math.sin(phi);
  nu = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);

  return {
    latitude: phi * RAD,
    longitude,
    height: p / Math.cos(phi) - nu,
  };
}

/** Arc-seconds to radians. */
const ARCSEC = Math.PI / (180 * 3600);

export function applyHelmert(
  position: Geocentric,
  parameters: HelmertParameters,
): Geocentric {
  const { x, y, z } = position;
  const s = 1 + (parameters.scalePpm ?? 0) / 1_000_000;

  /*
   * Position Vector is EPSG method 9606; Coordinate Frame is 9607. They are
   * the same transformation with the rotation signs reversed, which is why the
   * sense is negated here rather than duplicating the arithmetic.
   */
  const sense = (parameters.convention ?? 'position-vector') === 'position-vector' ? 1 : -1;
  const rx = (parameters.rx ?? 0) * ARCSEC * sense;
  const ry = (parameters.ry ?? 0) * ARCSEC * sense;
  const rz = (parameters.rz ?? 0) * ARCSEC * sense;

  return {
    x: parameters.dx + s * (x - rz * y + ry * z),
    y: parameters.dy + s * (rz * x + y - rx * z),
    z: parameters.dz + s * (-ry * x + rx * y + z),
  };
}

/** The same transformation run backwards, for going the other way. */
export function invertHelmert(parameters: HelmertParameters): HelmertParameters {
  return {
    dx: -parameters.dx,
    dy: -parameters.dy,
    dz: -parameters.dz,
    ...(parameters.rx === undefined ? {} : { rx: -parameters.rx }),
    ...(parameters.ry === undefined ? {} : { ry: -parameters.ry }),
    ...(parameters.rz === undefined ? {} : { rz: -parameters.rz }),
    ...(parameters.scalePpm === undefined ? {} : { scalePpm: -parameters.scalePpm }),
    ...(parameters.convention === undefined ? {} : { convention: parameters.convention }),
  };
}

/**
 * Move a geographic position from one datum to another.
 *
 * Note that the inverse is only an exact inverse for a pure translation. With
 * rotations and a scale, negating the parameters is the standard reversible
 * approximation and is accurate to well under a millimetre for the magnitudes
 * real transformations use — but it is worth knowing it is not algebraically
 * exact, because somebody will eventually round-trip a position and wonder
 * about the last digit.
 */
export function shiftDatum(
  position: Geographic,
  from: Ellipsoid,
  to: Ellipsoid,
  parameters: HelmertParameters,
): Geographic {
  const geocentric = geographicToGeocentric(position, from);
  const shifted = applyHelmert(geocentric, parameters);
  return geocentricToGeographic(shifted, to);
}
