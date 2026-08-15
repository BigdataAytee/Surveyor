/**
 * Transverse Mercator, forward and inverse.
 *
 * The Redfearn series, which is what national mapping agencies publish their
 * own worked examples against and what every Nigerian grid — UTM and the three
 * belts alike — is defined on. Accurate to well under a millimetre anywhere
 * inside a zone's proper extent, which is far finer than any survey it will be
 * asked to convert.
 *
 * Written out in the authorities' own notation (I…VI going one way, VII…XIIA
 * coming back) rather than refactored into something prettier. The point of
 * this file is that it can be checked line by line against the published
 * formulas by somebody who does not know this codebase, and a tidier version
 * that cannot be checked is not an improvement in code whose errors are
 * invisible.
 */

import { constantsOf, DEG, RAD, type Ellipsoid } from './ellipsoid.js';

/** Everything that defines one Transverse Mercator grid. */
export interface TransverseMercator {
  readonly ellipsoid: Ellipsoid;
  /** Latitude of the true origin, degrees. */
  readonly latitudeOfOrigin: number;
  /** Longitude of the true origin — the central meridian — in degrees. */
  readonly centralMeridian: number;
  /** Scale factor on the central meridian. */
  readonly scaleFactor: number;
  /** False easting of the true origin, metres. */
  readonly falseEasting: number;
  /** False northing of the true origin, metres. */
  readonly falseNorthing: number;
}

export interface Geographic {
  /** Degrees, positive north. */
  readonly latitude: number;
  /** Degrees, positive east. */
  readonly longitude: number;
  /** Height above the ellipsoid, metres. Absent means unknown, not zero. */
  readonly height?: number;
}

export interface GridPosition {
  readonly easting: number;
  readonly northing: number;
}

/**
 * Meridional arc from the latitude of origin, scaled.
 *
 * The series in `n` (the third flattening) rather than in `e²`: it converges
 * far faster, which is why the published formulations use it.
 */
function meridionalArc(latitude: number, grid: TransverseMercator): number {
  const { b, n } = constantsOf(grid.ellipsoid);
  const k0 = grid.scaleFactor;
  const phi = latitude * DEG;
  const phi0 = grid.latitudeOfOrigin * DEG;

  const n2 = n * n;
  const n3 = n2 * n;

  return (
    b *
    k0 *
    ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (phi - phi0) -
      (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(phi - phi0) * Math.cos(phi + phi0) +
      ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (phi - phi0)) * Math.cos(2 * (phi + phi0)) -
      (35 / 24) * n3 * Math.sin(3 * (phi - phi0)) * Math.cos(3 * (phi + phi0)))
  );
}

/** Radii of curvature and η² at a latitude, all scaled by k0. */
function curvature(latitude: number, grid: TransverseMercator) {
  const { a, e2 } = constantsOf(grid.ellipsoid);
  const k0 = grid.scaleFactor;
  const phi = latitude * DEG;
  const sinPhi = Math.sin(phi);
  const w = 1 - e2 * sinPhi * sinPhi;

  // ν — the transverse radius of curvature; ρ — the meridional one.
  const nu = (a * k0) / Math.sqrt(w);
  const rho = (a * k0 * (1 - e2)) / (w * Math.sqrt(w));

  return { nu, rho, eta2: nu / rho - 1 };
}

export function geographicToGrid(
  position: Geographic,
  grid: TransverseMercator,
): GridPosition {
  const phi = position.latitude * DEG;
  const { nu, rho, eta2 } = curvature(position.latitude, grid);

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const t2 = tanPhi * tanPhi;
  const t4 = t2 * t2;

  const dLon = (position.longitude - grid.centralMeridian) * DEG;
  const dl2 = dLon * dLon;

  const I = meridionalArc(position.latitude, grid) + grid.falseNorthing;
  const II = (nu / 2) * sinPhi * cosPhi;
  const III = (nu / 24) * sinPhi * cosPhi ** 3 * (5 - t2 + 9 * eta2);
  const IIIA = (nu / 720) * sinPhi * cosPhi ** 5 * (61 - 58 * t2 + t4);
  const IV = nu * cosPhi;
  const V = (nu / 6) * cosPhi ** 3 * (nu / rho - t2);
  const VI = (nu / 120) * cosPhi ** 5 * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2);

  return {
    northing: I + II * dl2 + III * dl2 * dl2 + IIIA * dl2 * dl2 * dl2,
    easting: grid.falseEasting + IV * dLon + V * dLon ** 3 + VI * dLon ** 5,
  };
}

export function gridToGeographic(
  position: GridPosition,
  grid: TransverseMercator,
): Geographic {
  const { a } = constantsOf(grid.ellipsoid);
  const k0 = grid.scaleFactor;

  /*
   * The footpoint latitude, found by iteration.
   *
   * There is no closed form for "which latitude has this meridional arc", so
   * the arc is computed for a guess and the guess corrected by the shortfall.
   * It converges in three or four passes; the loop is bounded anyway, because
   * an unbounded numerical loop in a geometry engine is a hang waiting for
   * unusual input.
   */
  let phi = grid.latitudeOfOrigin;
  for (let pass = 0; pass < 32; pass += 1) {
    const remainder = position.northing - grid.falseNorthing - meridionalArc(phi, grid);
    // 0.01 mm. Far below the precision of any survey, and reached long before
    // the iteration limit at any latitude these grids cover.
    if (Math.abs(remainder) < 0.00001) break;
    phi += (remainder / (a * k0)) * RAD;
  }

  const { nu, rho, eta2 } = curvature(phi, grid);
  const phiRad = phi * DEG;
  const tanPhi = Math.tan(phiRad);
  const secPhi = 1 / Math.cos(phiRad);
  const t2 = tanPhi * tanPhi;
  const t4 = t2 * t2;
  const t6 = t4 * t2;

  const VII = tanPhi / (2 * rho * nu);
  const VIII = (tanPhi / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tanPhi / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = secPhi / nu;
  const XI = (secPhi / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (secPhi / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (secPhi / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  const dE = position.easting - grid.falseEasting;
  const dE2 = dE * dE;

  const latitude = (phiRad - VII * dE2 + VIII * dE2 * dE2 - IX * dE2 * dE2 * dE2) * RAD;
  const longitude =
    grid.centralMeridian + (X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7) * RAD;

  return { latitude, longitude };
}
