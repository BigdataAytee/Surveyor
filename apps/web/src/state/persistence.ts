/**
 * Local persistence.
 *
 * Survey data is work someone did on site; losing it to a refresh is not
 * acceptable, so the model is written to localStorage as it changes. Writes are
 * debounced (B.16 lists debounced persistence among the performance rules)
 * because every keystroke in a coordinate field is a state change.
 *
 * Only the confirmed model is stored. Pending AI suggestions deliberately do
 * not survive a reload: a proposal the user never saw the preview for should
 * not reappear later already attached to their project.
 */

import type { SurveyDataModel } from '@surveyor/contracts';

const KEY = 'surveyor.project.v1';
const DEBOUNCE_MS = 400;

let timer: number | undefined;

export function saveModel(model: SurveyDataModel): void {
  if (typeof window === 'undefined') return;

  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(model));
    } catch {
      // A full or unavailable store (private browsing, quota) must not take
      // the app down — the user keeps working, they just do not get a restore.
    }
  }, DEBOUNCE_MS);
}

/**
 * Read back a stored project.
 *
 * Returns null on anything unexpected rather than throwing: a stored model
 * from an older shape is not worth crashing the app over, and the caller
 * falls back to the sample project.
 */
export function loadModel(): SurveyDataModel | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SurveyDataModel>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.crs ||
      !parsed.metadata ||
      !Array.isArray(parsed.points) ||
      !Array.isArray(parsed.boundary)
    ) {
      return null;
    }

    return {
      metadata: parsed.metadata,
      crs: parsed.crs,
      points: parsed.points,
      boundary: parsed.boundary,
      siteFeatures: parsed.siteFeatures ?? [],
      notes: parsed.notes ?? [],
    };
  } catch {
    return null;
  }
}

export function clearStoredModel(): void {
  if (typeof window === 'undefined') return;
  window.clearTimeout(timer);
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do; the next save overwrites it anyway.
  }
}
