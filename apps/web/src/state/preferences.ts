/**
 * Settings that belong to the person rather than to a survey.
 *
 * The project library stores one model per project. This stores the things
 * that are the same whichever project is open: who is drawing, which
 * jurisdiction they usually work under, and how they like the canvas set up.
 *
 * Kept apart from the survey deliberately. A surveyor's name and registration
 * number are theirs, not the site's — copying them into every project would
 * mean correcting a typo once per plan forever, and would put personal details
 * into every exported model.
 *
 * Local, like everything else here: this is a browser, not an account.
 */

const KEY = 'surveyor.preferences.v1';

/**
 * Who is drawing, for the title block.
 *
 * Every field is optional. A plan can be drawn without any of it, and half-
 * filled is a normal state rather than an error — the export gate is what
 * decides whether a sheet is issuable, not this.
 */
export interface SurveyorProfile {
  readonly name?: string;
  readonly firm?: string;
  /** Registration or licence number, as it should print on the sheet. */
  readonly registration?: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface Preferences {
  readonly profile: SurveyorProfile;
  readonly theme: 'light' | 'dark';
  /** Pre-selected on a new project. */
  readonly jurisdiction?: string;
  readonly snapping: boolean;
  readonly showGrid: boolean;
  readonly showLabels: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  profile: {},
  theme: 'light',
  snapping: true,
  showGrid: true,
  showLabels: true,
};

export function loadPreferences(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFERENCES;

    const parsed = JSON.parse(raw) as Partial<Preferences>;
    // Merged over the defaults rather than trusted whole: a stored shape from
    // an older build is missing keys, and a missing `snapping` should mean
    // "the default" and not "off".
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      profile: { ...DEFAULT_PREFERENCES.profile, ...(parsed.profile ?? {}) },
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // A full quota must not stop someone working. The preference is still
    // live in memory for this session; it simply will not outlast it.
  }
}

/**
 * Roughly how much of this browser's storage the app is using, in bytes.
 *
 * Counted rather than measured: there is no portable way to ask a browser how
 * much a key costs, so this sums what was written. Two bytes per character is
 * the right approximation for the UTF-16 most engines store.
 */
export function storageUsed(): number {
  if (typeof window === 'undefined') return 0;
  let total = 0;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith('surveyor.')) continue;
    total += (key.length + (window.localStorage.getItem(key)?.length ?? 0)) * 2;
  }
  return total;
}

/**
 * Remove everything this app has stored on this device.
 *
 * Only its own keys: another app sharing the origin is not ours to clear.
 * Irreversible, and the callers say so before calling it.
 */
export function clearAllData(): void {
  if (typeof window === 'undefined') return;
  const ours: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key?.startsWith('surveyor.')) ours.push(key);
  }
  for (const key of ours) window.localStorage.removeItem(key);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
