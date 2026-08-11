/**
 * The project library: many surveys, kept, with a history each.
 *
 * The app held exactly one project in local storage, which meant starting a
 * second one destroyed the first. A surveyor works several sites at once and
 * comes back to a plan weeks later to revise it, so "one project" was not a
 * simplification — it was a data-loss bug wearing a simple interface.
 *
 * Two things are stored per project: the current model, and a bounded history
 * of earlier versions. The history is what makes autosave safe to have. Saving
 * continuously is only an improvement if you can get back to what you had
 * before it saved; without that, autosave faithfully preserves a mistake.
 *
 * Storage is local, which is a real limit and is stated as one — see
 * `STORAGE_NOTE`. Nothing here syncs, and a cleared browser is a lost library.
 */

import type { SurveyDataModel } from '@surveyor/contracts';

const INDEX_KEY = 'surveyor.library.v1';
const PROJECT_PREFIX = 'surveyor.project.';

/**
 * How many earlier versions each project keeps.
 *
 * Enough to undo a bad afternoon, few enough that a browser quota does not
 * turn into a lost project. Versions are whole models rather than diffs: a
 * survey is small, and a diff chain has to be replayed correctly to be worth
 * anything, which is a lot of machinery to trust with someone's work.
 */
export const VERSION_LIMIT = 20;

/** Only snapshot a version when the work has moved on this much. */
const VERSION_INTERVAL_MS = 60_000;

export const STORAGE_NOTE =
  'Projects are saved in this browser only. Clearing site data removes them, ' +
  'and they do not follow you to another device.';

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pointCount: number;
  readonly featureCount: number;
  /** Rough area in square metres, for the card. Null until a boundary closes. */
  readonly area: number | null;
  readonly versionCount: number;
  /**
   * Marked by the surveyor as one to keep to hand.
   *
   * Optional rather than defaulted to false, so a project stored by an earlier
   * build reads back as unstarred without needing to be rewritten.
   */
  readonly starred?: boolean;
}

export interface StoredVersion {
  readonly at: string;
  readonly model: SurveyDataModel;
}

interface StoredProject {
  readonly summary: ProjectSummary;
  readonly model: SurveyDataModel;
  readonly versions: readonly StoredVersion[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every project, newest first. Never throws — a broken entry is skipped. */
export function listProjects(): readonly ProjectSummary[] {
  return readIndex()
    .map((id) => readProject(id)?.summary)
    .filter((summary): summary is ProjectSummary => summary !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadProject(id: string): SurveyDataModel | null {
  return readProject(id)?.model ?? null;
}

export function versionsOf(id: string): readonly StoredVersion[] {
  return [...(readProject(id)?.versions ?? [])].sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Save a project, snapshotting the previous state when enough has changed.
 *
 * The snapshot is time-based rather than edit-based on purpose. Every
 * keystroke in a coordinate field is an edit, and a history of two hundred
 * near-identical versions is not a history anybody can use — it is a list to
 * scroll past. A version a minute produces something a person can navigate.
 */
export function saveProject(
  id: string,
  model: SurveyDataModel,
  now = new Date(),
): ProjectSummary | null {
  const existing = readProject(id);
  const stamp = now.toISOString();

  const versions = (() => {
    if (!existing) return [];
    const latest = existing.versions[existing.versions.length - 1];
    const since = latest ? now.getTime() - Date.parse(latest.at) : Infinity;
    if (since < VERSION_INTERVAL_MS) return existing.versions;

    // The version recorded is the state *before* this save, which is what
    // "restore" has to mean — restoring to the thing you just typed would do
    // nothing at all.
    return [...existing.versions, { at: existing.summary.updatedAt, model: existing.model }].slice(
      -VERSION_LIMIT,
    );
  })();

  const summary: ProjectSummary = {
    id,
    name: nameOf(model, existing?.summary.name),
    createdAt: existing?.summary.createdAt ?? stamp,
    updatedAt: stamp,
    pointCount: model.points.length,
    featureCount: model.siteFeatures.length,
    area: null,
    versionCount: versions.length,
    // Carried across explicitly. The summary is rebuilt on every autosave, so
    // anything not named here is dropped — and a star that vanished on the
    // next keystroke would look like the app forgetting on purpose.
    ...(existing?.summary.starred ? { starred: true } : {}),
  };

  return write(id, { summary, model, versions }) ? summary : null;
}

/** Record the area the pipeline computed, so a card can show it. */
export function recordArea(id: string, area: number | null): void {
  const project = readProject(id);
  if (!project) return;
  write(id, { ...project, summary: { ...project.summary, area } });
}

export function renameProject(id: string, name: string): void {
  const project = readProject(id);
  if (!project) return;

  const trimmed = name.trim();
  write(id, {
    ...project,
    summary: { ...project.summary, name: trimmed.length > 0 ? trimmed : project.summary.name },
    // The name lives on the model too, because that is what the title block
    // prints — keeping them apart would let a plan be filed under one name and
    // printed under another.
    model: { ...project.model, metadata: { ...project.model.metadata, siteAddress: trimmed } },
  });
}

export function duplicateProject(id: string, now = new Date()): string | null {
  const project = readProject(id);
  if (!project) return null;

  const copyId = newProjectId();
  const stamp = now.toISOString();
  const ok = write(copyId, {
    summary: {
      ...project.summary,
      id: copyId,
      name: `${project.summary.name} (copy)`,
      createdAt: stamp,
      updatedAt: stamp,
      versionCount: 0,
    },
    model: project.model,
    // A copy starts its own history. Inheriting the original's would let you
    // "restore" a copy to a state the copy was never in.
    versions: [],
  });
  return ok ? copyId : null;
}

/**
 * Star or unstar a project.
 *
 * Only the summary moves, never the model: which surveys someone keeps to
 * hand is a fact about them, not about the site, and it must not touch the
 * survey data or its version history.
 */
export function toggleStar(id: string): boolean {
  const project = readProject(id);
  if (!project) return false;

  const starred = !project.summary.starred;
  write(id, { ...project, summary: { ...project.summary, starred } });
  return starred;
}

export function deleteProject(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`${PROJECT_PREFIX}${id}`);
    writeIndex(readIndex().filter((entry) => entry !== id));
  } catch {
    // A storage failure here leaves the project in place, which is the safe
    // direction to fail in.
  }
}

/**
 * Put a project back to one of its earlier versions.
 *
 * The current state is pushed onto the history first, so restoring is itself
 * undoable. Losing the present in order to recover the past is not a recovery
 * feature.
 */
export function restoreVersion(id: string, at: string, now = new Date()): SurveyDataModel | null {
  const project = readProject(id);
  if (!project) return null;

  const target = project.versions.find((version) => version.at === at);
  if (!target) return null;

  const versions = [
    ...project.versions.filter((version) => version.at !== at),
    { at: project.summary.updatedAt, model: project.model },
  ].slice(-VERSION_LIMIT);

  const ok = write(id, {
    summary: {
      ...project.summary,
      updatedAt: now.toISOString(),
      pointCount: target.model.points.length,
      featureCount: target.model.siteFeatures.length,
      versionCount: versions.length,
    },
    model: target.model,
    versions,
  });
  return ok ? target.model : null;
}

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function nameOf(model: SurveyDataModel, fallback?: string): string {
  const address = model.metadata.siteAddress?.trim();
  if (address && address.length > 0) return address;
  return fallback ?? 'Untitled plan';
}

function readIndex(): readonly string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
  } catch {
    // Nothing useful to do: the caller's project is still in memory, and the
    // app must not stop working because a quota was reached.
  }
}

function readProject(id: string): StoredProject | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${PROJECT_PREFIX}${id}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredProject>;
    // A stored shape from an older build is skipped rather than crashing the
    // library — one unreadable project must not hide the rest.
    if (!parsed?.summary?.id || !parsed.model?.crs || !Array.isArray(parsed.model.points)) {
      return null;
    }
    return {
      summary: parsed.summary,
      model: parsed.model,
      versions: Array.isArray(parsed.versions) ? parsed.versions : [],
    };
  } catch {
    return null;
  }
}

function write(id: string, project: StoredProject): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(`${PROJECT_PREFIX}${id}`, JSON.stringify(project));
    const index = readIndex();
    if (!index.includes(id)) writeIndex([...index, id]);
    return true;
  } catch {
    // Quota exceeded, most likely. Dropping the oldest version and retrying
    // once saves the project at the cost of the deepest history, which is the
    // right thing to lose first.
    try {
      const trimmed = { ...project, versions: project.versions.slice(-1) };
      window.localStorage.setItem(`${PROJECT_PREFIX}${id}`, JSON.stringify(trimmed));
      const index = readIndex();
      if (!index.includes(id)) writeIndex([...index, id]);
      return true;
    } catch {
      return false;
    }
  }
}
