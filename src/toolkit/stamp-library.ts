// The stamp brush's library, kept in the browser (IndexedDB) so captured
// stamps are still there after a reload. Every call fails soft: without
// storage (private window, blocked site data) the library simply lives for the
// session only.

type StoredStamp = { id: string, name: string, ply: Blob, order: number };

const DB_NAME = 'supersplat-toolkit-stamps';
const STORE = 'stamps';

let opening: Promise<IDBDatabase | null> | null = null;

const openDb = () => {
    opening = opening ?? new Promise<IDBDatabase | null>((resolve) => {
        try {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore(STORE, { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return opening;
};

const run = async <T>(mode: 'readonly' | 'readwrite', fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
    const db = await openDb();
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
        try {
            const request = fn(db.transaction(STORE, mode).objectStore(STORE));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
};

const loadStamps = async (): Promise<StoredStamp[]> => {
    const all = await run<StoredStamp[]>('readonly', store => store.getAll() as IDBRequest<StoredStamp[]>);
    return (all ?? []).sort((a, b) => a.order - b.order);
};

const saveStamp = (stamp: StoredStamp) => run('readwrite', store => store.put(stamp));

const deleteStamp = (id: string) => run('readwrite', store => store.delete(id));

export { StoredStamp, loadStamps, saveStamp, deleteStamp };
