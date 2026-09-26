const DB_NAME = "ihobs";
const DB_VERSION = 1;
const STORE = "handles";
const ROOT_KEY = "vault-root";

export interface HandleRecord {
  name: string;
  handle: FileSystemDirectoryHandle;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function saveRoot(handle: FileSystemDirectoryHandle): Promise<void> {
  await tx("readwrite", (s) => s.put(handle, ROOT_KEY) as IDBRequest<IDBValidKey>);
}

export async function loadRoot(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await tx<FileSystemDirectoryHandle | undefined>("readonly", (s) =>
    s.get(ROOT_KEY)
  );
  if (!handle) return null;
  const state = await (
    handle as unknown as {
      queryPermission(d?: { mode?: string }): Promise<PermissionState>;
    }
  ).queryPermission({ mode: "readwrite" });
  return state === "granted" || state === "prompt" ? handle : null;
}

export async function ensureReadWrite(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission(d?: { mode?: string }): Promise<PermissionState>;
    requestPermission(d?: { mode?: string }): Promise<PermissionState>;
  };
  let state = await h.queryPermission({ mode: "readwrite" });
  if (state !== "granted") {
    state = await h.requestPermission({ mode: "readwrite" });
  }
  return state === "granted";
}

export async function pickRoot(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({
    id: "ihobs-vault",
    mode: "readwrite",
    startIn: "documents"
  });
  await saveRoot(handle);
  return handle;
}

export async function clearRoot(): Promise<void> {
  await tx("readwrite", (s) => s.delete(ROOT_KEY) as unknown as IDBRequest<undefined>);
}
