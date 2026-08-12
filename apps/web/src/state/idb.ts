/**
 * The smallest useful wrapper around IndexedDB.
 *
 * Local storage holds the projects, and that is where it should stay: it is
 * synchronous, simple, and a survey is small. A photographed field note is
 * not. A page of points at 1600px is a few hundred kilobytes, and storing it
 * as base64 in the same five-megabyte quota as someone's work means a queued
 * photo can push a survey out. That is the wrong thing to lose.
 *
 * So anything large goes here instead, where blobs are stored as blobs and the
 * quota is orders of magnitude larger. This is thirty lines rather than a
 * library because the app needs exactly one object store with a key and a
 * value, and every failure is already survivable — the queue is a convenience,
 * and a browser that refuses to open a database gets an app that behaves as it
 * did before the queue existed.
 */

const DB_NAME = 'surveyor';
const DB_VERSION = 1;
const STORE = 'outbox';

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;

  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Private browsing in some browsers throws here rather than failing the
      // request.
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked open means another tab holds an older version. Rather than
    // hang, give up: the caller treats it as "no database".
    request.onblocked = () => resolve(null);
  });

  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const transaction = db.transaction(STORE, mode);
          const request = work(transaction.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          transaction.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export function idbPut<T extends { readonly id: string }>(record: T): Promise<unknown> {
  return run('readwrite', (store) => store.put(record));
}

export function idbGetAll<T>(): Promise<readonly T[]> {
  return run<T[]>('readonly', (store) => store.getAll() as IDBRequest<T[]>).then(
    (rows) => rows ?? [],
  );
}

export function idbDelete(id: string): Promise<unknown> {
  return run('readwrite', (store) => store.delete(id));
}

export function idbClear(): Promise<unknown> {
  return run('readwrite', (store) => store.clear());
}
