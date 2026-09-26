export async function readText(file: FileSystemFileHandle): Promise<string> {
  const f = await file.getFile();
  return f.text();
}

export async function readBytes(file: FileSystemFileHandle): Promise<ArrayBuffer> {
  const f = await file.getFile();
  return f.arrayBuffer();
}

export async function writeText(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: string
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await (file as unknown as {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }).createWritable();
  await w.write(data);
  await w.close();
}

export async function ensureDirPath(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

export async function resolveFile(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create = false
): Promise<FileSystemFileHandle> {
  if (segments.length === 0) throw new Error("empty path");
  const dirs = segments.slice(0, -1);
  const name = segments[segments.length - 1];
  const dir = dirs.length ? await ensureDirPath(root, create ? dirs : dirs) : root;
  return dir.getFileHandle(name, { create });
}

export async function resolveDir(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg);
  }
  return dir;
}
