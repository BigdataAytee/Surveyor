/**
 * Reference ellipsoids.
 *
 * Two numbers define one — the semi-major axis and the flattening — and every
 * other quantity here is derived from them rather than quoted, so there is one
 * place to be wrong rather than six.
 *
 * The defining constants are given exactly as their authorities publish them.
 * `1/f` is written as the inverse flattening because that is the form the
 * definitions use; deriving `f` from it loses nothing, while quoting a rounded
 * `f` would.
 */

export interface Ellipsoid {
  readonly name: string;
  /** Semi-major axis, metres. */
  readonly a: number;
  /** Inverse flattening, 1/f, as published. */
  readonly invF: number;
}

/**
 * Clarke 1880 (RGS) — the ellipsoid the Minna datum is defined on.
 *
 * "(RGS)" matters. There are several Clarke 1880 ellipsoids in circulation
 * differing in the fourth decimal of the axis and in the flattening, and they
 * are not interchangeable: picking the wrong one moves a position by metres.
 * Minna uses the Royal Geographical Society variant, a = 6378249.145 m with
 * 1/f = 293.465.
 */
export const CLARKE_1880_RGS: Ellipsoid = {
  name: 'Clarke 1880 (RGS)',
  a: 6378249.145,
  invF: 293.465,
};

/** WGS 84, as defined by NIMA TR8350.2. */
export const WGS84_ELLIPSOID: Ellipsoid = {
  name: 'WGS 84',
  a: 6378137,
  invF: 298.257223563,
};

/** Airy 1830 — the ellipsoid OSGB36 and the British National Grid sit on. */
export const AIRY_1830: Ellipsoid = {
  name: 'Airy 1830',
  a: 6377563.396,
  invF: 299.3249646,
};

export interface EllipsoidConstants {
  readonly a: number;
  /** Semi-minor axis. */
  readonly b: number;
  readonly f: number;
  /** First eccentricity squared. */
  readonly e2: number;
  /** Second eccentricity squared. */
  readonly ep2: number;
  /** Third flattening, used by the meridional arc series. */
  readonly n: number;
}

export function constantsOf(ellipsoid: Ellipsoid): EllipsoidConstants {
  const { a, invF } = ellipsoid;
  const f = 1 / invF;
  const b = a * (1 - f);
  const e2 = 2 * f - f * f;

  return {
    a,
    b,
    f,
    e2,
    ep2: e2 / (1 - e2),
    n: (a - b) / (a + b),
  };
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
