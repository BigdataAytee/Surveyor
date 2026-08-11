/**
 * Documents attached to a project.
 *
 * A survey does not arrive out of nowhere. There is a deed, a title plan, a
 * client's brief, a photograph of the field book — and when a plan is
 * questioned two years later, what settles it is the paperwork the numbers
 * came from. The app could read a photographed note and then had nowhere to
 * keep the photograph, which meant the evidence was discarded the moment it
 * had been transcribed.
 *
 * Stored as data URLs in local storage, which is the honest limit of a browser
 * with no server behind it. That imposes a size cap, and the cap is enforced
 * and explained rather than discovered when a save silently fails: a document
 * store that loses documents is worse than none, because it is trusted.
 */

const PREFIX = 'surveyor.documents.';

/**
 * The largest single file that may be attached.
 *
 * Local storage is a few megabytes in total and holds the surveys as well.
 * Two megabytes takes a photograph of a field book comfortably and leaves
 * room for the work itself.
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** The most a single project's documents may take together. */
export const MAX_PROJECT_BYTES = 6 * 1024 * 1024;

export interface StoredDocument {
  readonly id: string;
  readonly name: string;
  /** MIME type as the browser reported it. */
  readonly type: string;
  readonly bytes: number;
  readonly addedAt: string;
  /** The file itself, as a data URL. */
  readonly data: string;
  /** What the surveyor said this is — a deed, a brief, a field note. */
  readonly note?: string;
}

export function listDocuments(projectId: string): readonly StoredDocument[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${projectId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredDocument[]) : [];
  } catch {
    return [];
  }
}

export type AttachResult =
  | { readonly ok: true; readonly documents: readonly StoredDocument[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Attach a file, or say why not.
 *
 * Refuses before writing rather than after: a browser that rejects an
 * over-quota write throws, and by then the caller has already told the user
 * the file was added.
 */
export function attachDocument(
  projectId: string,
  file: { readonly name: string; readonly type: string; readonly size: number },
  data: string,
  note?: string,
): AttachResult {
  if (file.size > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      reason:
        `“${file.name}” is ${formatSize(file.size)}, and the limit for one document is ` +
        `${formatSize(MAX_DOCUMENT_BYTES)}. This app stores documents in the browser, ` +
        'which has no room for large files.',
    };
  }

  const existing = listDocuments(projectId);
  const used = existing.reduce((total, document) => total + document.bytes, 0);
  if (used + file.size > MAX_PROJECT_BYTES) {
    return {
      ok: false,
      reason:
        `This project's documents already come to ${formatSize(used)}, and the limit is ` +
        `${formatSize(MAX_PROJECT_BYTES)}. Remove one before adding another.`,
    };
  }

  const next: StoredDocument[] = [
    ...existing,
    {
      id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      type: file.type || 'application/octet-stream',
      bytes: file.size,
      addedAt: new Date().toISOString(),
      data,
      ...(note && note.trim().length > 0 ? { note: note.trim() } : {}),
    },
  ];

  try {
    window.localStorage.setItem(`${PREFIX}${projectId}`, JSON.stringify(next));
    return { ok: true, documents: next };
  } catch {
    return {
      ok: false,
      reason:
        'The browser refused to store that — its space for this site is full. ' +
        'Removing a document or an old project will make room.',
    };
  }
}

export function removeDocument(
  projectId: string,
  documentId: string,
): readonly StoredDocument[] {
  const next = listDocuments(projectId).filter((document) => document.id !== documentId);
  if (typeof window === 'undefined') return next;
  try {
    window.localStorage.setItem(`${PREFIX}${projectId}`, JSON.stringify(next));
  } catch {
    // Removing should not be able to fail on space, but if the write is
    // refused the document simply stays. Saying nothing is wrong here, so the
    // caller re-reads and shows what is actually stored.
  }
  return listDocuments(projectId);
}

/** Read a file as a data URL, so it can be stored as text. */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
