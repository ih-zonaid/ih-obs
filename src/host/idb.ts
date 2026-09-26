const DB_NAME = "ihobs";
const DB_VERSION = 2;
const HANDLES = "handles";
const VAULTS = "vaults";
const META = "meta";

export interface VaultRecord {
  id: string;
  label: string;
  handle: FileSystemDirectoryHandle;
  addedAt: number;
  lastOpenedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains(VAULTS)) db.createObjectStore(VAULTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

function uid(): string {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newId(): string {
  return uid();
}

export async function queryPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite"
): Promise<PermissionState> {
  const h = handle as unknown as {
    queryPermission(d: { mode: string }): Promise<PermissionState>;
  };
  try {
    return await h.queryPermission({ mode });
  } catch {
    return "denied";
  }
}

export async function requestReadWrite(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission(d: { mode: string }): Promise<PermissionState>;
    requestPermission(d: { mode: string }): Promise<PermissionState>;
  };
  let state = await h.queryPermission({ mode: "readwrite" });
  if (state !== "granted") state = await h.requestPermission({ mode: "readwrite" });
  return state === "granted";
}

export async function listVaults(): Promise<VaultRecord[]> {
  const all = await run<VaultRecord[]>(VAULTS, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function putVault(rec: VaultRecord): Promise<void> {
  await run(VAULTS, "readwrite", (s) => s.put(rec) as IDBRequest<IDBValidKey>);
}

export async function deleteVault(id: string): Promise<void> {
  await run(VAULTS, "readwrite", (s) => s.delete(id) as unknown as IDBRequest<undefined>);
}

export async function getCurrentVaultId(): Promise<string | null> {
  const id = await run<string | undefined>(META, "readonly", (s) => s.get("current"));
  return id ?? null;
}

export async function setCurrentVaultId(id: string | null): Promise<void> {
  await run(
    META,
    "readwrite",
    (s) =>
      (id === null ? s.delete("current") : s.put(id, "current")) as IDBRequest<IDBValidKey>
  );
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({
    id: "ihobs-vault",
    mode: "readwrite",
    startIn: "documents"
  });
}

export async function getLegacyRoot(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await run<FileSystemDirectoryHandle | undefined>(HANDLES, "readonly", (s) =>
    s.get("vault-root")
  );
  return handle ?? null;
}

export async function clearLegacyRoot(): Promise<void> {
  await run(HANDLES, "readwrite", (s) => s.delete("vault-root") as unknown as IDBRequest<undefined>);
}
