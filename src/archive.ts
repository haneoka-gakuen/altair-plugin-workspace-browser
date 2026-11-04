import { Zip, ZipPassThrough } from "fflate";
import { normalizeBrowserWorkspacePath } from "./workspace.js";
export interface WorkspaceArchiveFile {
  readonly path: string;
  readonly blob: Blob;
}
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;

// fflate#260: ZipDeflate can emit invalid back-references for binary inputs.
class CompressedEntry extends ZipPassThrough {
  override compression = 8;
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  readonly completed: Promise<void>;
  readonly terminate: () => void;
  pendingWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    super(path);
    const encoder = new CompressionStream("deflate-raw");
    this.writer = encoder.writable.getWriter();
    const reader = encoder.readable.getReader();
    this.completed = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          this.ondata(null, value ?? new Uint8Array(), done);
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    })();
    void this.completed.catch(() => undefined);
    this.terminate = () => {
      void this.writer.abort().catch(() => undefined);
      void reader.cancel().catch(() => undefined);
    };
  }

  override process(chunk: Uint8Array, final: boolean): void {
    this.pendingWrite = final ? this.writer.close() : this.writer.write(chunk as Uint8Array<ArrayBuffer>);
  }
}
const archivePath = (path: string) => {
  const canonical = normalizeBrowserWorkspacePath(path);
  if (canonical !== path || /[\u0000-\u001f\u007f]/u.test(path))
    throw new Error("The archive contains an invalid path");
  return canonical;
};
function archiveDirectories(files: readonly WorkspaceArchiveFile[], folders: readonly string[]): string[] {
  const filePaths = new Set(files.map((file) => file.path)),
    result = new Set<string>();
  const add = (path: string) => {
    archivePath(path);
    if (filePaths.has(path)) throw new Error("The archive contains duplicate paths");
    result.add(path);
  };
  for (const path of folders) {
    const parts = archivePath(path).split("/");
    for (let i = 1; i <= parts.length; i++) add(parts.slice(0, i).join("/"));
  }
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) add(parts.slice(0, i).join("/"));
  }
  return [...result].sort();
}
/** Shared streamed ZIP writer for native projects and engine-backed games. */
export async function createWorkspaceZip(
  files: readonly WorkspaceArchiveFile[],
  folders: readonly string[] = [],
  signal?: AbortSignal,
  compress: ReadonlySet<string> = new Set(),
): Promise<Blob> {
  const paths = new Set<string>();
  for (const file of files) {
    archivePath(file.path);
    if (paths.has(file.path)) throw new Error("The archive contains duplicate paths");
    paths.add(file.path);
  }
  const directories = archiveDirectories(files, folders);
  if (files.length + directories.length > MAX_ARCHIVE_ENTRIES) throw new Error("The archive contains too many entries");
  if (files.reduce((size, file) => size + file.blob.size, 0) > MAX_ARCHIVE_BYTES)
    throw new Error("The project exceeds 2 GB");
  const chunks: BlobPart[] = [];
  let failure: Error | undefined;
  let finished = false;
  const archive = new Zip((error, data, final) => {
    if (error) failure = error;
    else chunks.push(new Blob([data as Uint8Array<ArrayBuffer>]));
    finished ||= final;
  });
  try {
    for (const path of directories) {
      signal?.throwIfAborted();
      const entry = new ZipPassThrough(`${path}/`);
      archive.add(entry);
      entry.push(new Uint8Array(), true);
    }
    for (const file of files) {
      signal?.throwIfAborted();
      const entry = compress.has(file.path) ? new CompressedEntry(file.path) : new ZipPassThrough(file.path);
      archive.add(entry);
      const reader = file.blob.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          signal?.throwIfAborted();
          if (done) {
            entry.push(new Uint8Array(), true);
            if (entry instanceof CompressedEntry) {
              await entry.pendingWrite;
              await entry.completed;
            }
            break;
          }
          entry.push(value);
          if (entry instanceof CompressedEntry) await entry.pendingWrite;
          if (failure) throw failure;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    archive.end();
    if (failure) throw failure;
    if (!finished) throw new Error("The archive is incomplete");
    return new Blob(chunks, { type: "application/zip" });
  } catch (error) {
    archive.terminate();
    throw error;
  }
}
