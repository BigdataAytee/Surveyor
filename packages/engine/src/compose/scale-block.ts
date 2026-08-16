/**
 * The representative fraction and the scale bar.
 *
 * Two ways of saying the same thing, and a plan carries both because they fail
 * differently. "1:500" is exact and useless once the sheet has been
 * photocopied at 94%; a bar is approximate and survives, because it shrinks
 * with the drawing. A surveyor checking a plan measures the bar.
 *
 * Everything here is arithmetic with right answers, which is why it is in the
 * engine and not in a component: what scale a drawing is at is a fact about
 * the drawing, and the sheet and the screen must not each work it out their
 * own way and disagree.
 */

import { STANDARD_SCALES } from './jurisdiction.js';

/** A drawing's extent, in survey units. */
export interface Extent {
  readonly width: number;
  readonly height: number;
}

/**
 * Pick the scale a plan of this size would be drawn at.
 *
 * Snapped to the standard set rather than computed exactly. A plan at 1:437 is
 * a plan nobody can measure: the whole point of a stated scale is that a ruler
 * and mental arithmetic get you a distance, and that only works at the round
 * numbers a drawing office uses.
 *
 * Always rounds *out* to the next standard scale up, never down — a scale that
 * does not fit means part of the parcel is off the sheet, which is the one
 * outcome worse than a slightly empty margin.
 */
export function chooseScale(
  extent: Extent,
  sheet: { readonly widthMm: number; readonly heightMm: number },
  scales: readonly number[] = STANDARD_SCALES,
): number {
  const usableWidth = Math.max(sheet.widthMm, 1) / 1000;
  const usableHeight = Math.max(sheet.heightMm, 1) / 1000;

  // The smallest denominator that fits both directions. Metres per metre, so
  // the sheet is converted to metres first.
  const needed = Math.max(
    extent.width / usableWidth,
    extent.height / usableHeight,
  );

  const ordered = [...scales].sort((a, b) => a - b);
  return ordered.find((scale) => scale >= needed) ?? ordered[ordered.length - 1] ?? 1000;
}

/** How a representative fraction is written on a plan. */
export function representativeFraction(denominator: number): string {
  return `SCALE 1:${Math.round(denominator).toLocaleString('en-GB')}`;
}

export interface ScaleBar {
  /** What the whole bar measures on the ground, in survey units. */
  readonly length: number;
  /** Where the ticks fall along it, in survey units from the left end. */
  readonly ticks: readonly number[];
  /** The number printed at the right-hand end. */
  readonly label: string;
  /** The bar's drawn length in millimetres at the chosen scale. */
  readonly lengthMm: number;
}

/**
 * Round numbers, in the 1–2–5 sequence every ruler and axis uses.
 *
 * A bar reading "0 … 37 m" is a bar nobody can read a distance off. These are
 * the intervals a person can divide by eye.
 */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * A scale bar sized for the scale it will be drawn at.
 *
 * `targetMm` is how long the bar should be on paper — long enough to measure
 * against, short enough to fit in a title block. The length it represents on
 * the ground is then snapped to a round number, which is what makes the bar
 * useful rather than decorative.
 */
export function scaleBar(denominator: number, targetMm = 50, unit = 'm'): ScaleBar {
  // What the target length would represent, before rounding.
  const raw = (targetMm / 1000) * denominator;

  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const step = NICE_STEPS.map((n) => n * magnitude).find((candidate) => candidate >= raw / 1.5);
  const length = step ?? magnitude * 10;

  /*
   * Four divisions, which is what a drawing office bar has: it lets a reader
   * take a quarter, a half and three quarters off it by eye. More divisions
   * make a bar that is finer than the line weight can distinguish.
   */
  const divisions = 4;
  const ticks = Array.from({ length: divisions + 1 }, (_, i) => (length * i) / divisions);

  return {
    length,
    ticks,
    label: `${trim(length)} ${unit}`,
    lengthMm: (length / denominator) * 1000,
  };
}

/** Drop a trailing `.0` — "50 m", not "50.0 m". */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
