import type {
  AltairBrowserWorkspaceCapabilities,
  AltairBrowserWorkspaceConnectOptions,
  AltairBrowserWorkspaceDisposable,
  AltairBrowserWorkspaceEvent,
  AltairBrowserWorkspaceFile,
  AltairBrowserWorkspaceIngestOptions,
  AltairBrowserWorkspaceLimits,
  AltairBrowserWorkspaceListener,
  AltairBrowserWorkspacePickOptions,
  AltairBrowserWorkspaceReadOptions,
  AltairBrowserWorkspaceService,
  AltairBrowserWorkspaceSnapshot,
  AltairBrowserWorkspaceSource,
  AltairBrowserWorkspaceWatchOptions,
  AltairBrowserWorkspaceWriteData,
  AltairBrowserWorkspaceWriteOptions,
} from "./contracts.js";
import {
  createBrowserWorkspaceEnvironment,
  type BrowserWorkspaceDirectoryHandle,
  type BrowserWorkspaceEnvironment,
  type BrowserWorkspaceFileHandle,
  type BrowserWorkspaceWritable,
} from "./environment.js";
import type {
  BrowserWorkspaceDirectoryPersistence,
  PersistedBrowserWorkspaceDirectory,
} from "./persistence.js";

interface WorkspaceEntry {
  readonly info: AltairBrowserWorkspaceFile;
  readonly file: File;
  readonly handle?: BrowserWorkspaceFileHandle;
}

interface ObjectUrlEntry {
  readonly fingerprint: string;
  readonly url: string;
}

interface WorkspaceLimits {
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly includeHidden: boolean;
  readonly ignoredDirectoryNames: ReadonlySet<string>;
}

interface CollectState {
  count: number;
  totalBytes: number;
}

export interface CreateAltairBrowserWorkspaceOptions extends AltairBrowserWorkspaceLimits {
  readonly environment?: BrowserWorkspaceEnvironment;
  readonly persistence?: BrowserWorkspaceDirectoryPersistence;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_IGNORED_DIRECTORY_NAMES = Object.freeze([
  ".git",
  ".nuxt",
  ".output",
  "build",
  "dist",
  "node_modules",
  "release",
]);
const MIN_WATCH_INTERVAL_MS = 100;
let fallbackId = 0;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ??
  new DOMException("Browser workspace operation aborted", "AbortError");

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const aborted = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

const settleWithAbort = <T>(
  operation: T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const linkAbortSignals = (
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const dispose = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      dispose();
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) {
        controller.abort(abortReason(signal));
      }
      dispose();
    };
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: controller.signal, dispose };
};

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return result;
};

const finiteLimit = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
  return result;
};

const normalizeLimits = (
  options: CreateAltairBrowserWorkspaceOptions,
): WorkspaceLimits => {
  const ignoredDirectoryNames = new Set(
    (options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES).map(
      (name) => {
        if (typeof name !== "string" || !name.trim() || name.includes("/")) {
          throw new TypeError(
            "Workspace ignored directory names must be non-empty path segments",
          );
        }
        return name.trim().toLocaleLowerCase();
      },
    ),
  );
  return {
    maxDepth: positiveInteger(
      options.maxDepth,
      DEFAULT_MAX_DEPTH,
      "Workspace maxDepth",
    ),
    maxFiles: positiveInteger(
      options.maxFiles,
      DEFAULT_MAX_FILES,
      "Workspace maxFiles",
    ),
    maxTotalBytes: finiteLimit(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      "Workspace maxTotalBytes",
    ),
    includeHidden: options.includeHidden === true,
    ignoredDirectoryNames,
  };
};

export const normalizeBrowserWorkspacePath = (input: string): string => {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("Workspace path must not be empty");
  }
  if (input.includes("\0")) {
    throw new TypeError("Workspace path contains a NUL byte");
  }
  const source = input.replaceAll("\\", "/").trim();
  if (
    source.startsWith("/") ||
    source.startsWith("//") ||
    /^[a-z]:/iu.test(source)
  ) {
    throw new TypeError(`Workspace path must be relative: ${input}`);
  }
  const segments: string[] = [];
  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new TypeError(`Workspace path escapes its root: ${input}`);
    }
    segments.push(segment);
  }
  if (!segments.length) {
    throw new TypeError("Workspace path must identify a file");
  }
  return segments.join("/");
};

const fileLike = (value: unknown): value is File => {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<File>;
  return (
    typeof file.name === "string" &&
    Boolean(file.name.trim()) &&
    typeof file.size === "number" &&
    Number.isFinite(file.size) &&
    file.size >= 0 &&
    typeof file.type === "string" &&
    typeof file.lastModified === "number" &&
    Number.isFinite(file.lastModified) &&
    typeof file.arrayBuffer === "function"
  );
};

const filePath = (file: File, commonRoot?: string): string => {
  const relative = (file as File & { readonly webkitRelativePath?: string })
    .webkitRelativePath;
  const normalized = normalizeBrowserWorkspacePath(
    typeof relative === "string" && relative.trim() ? relative : file.name,
  );
  return commonRoot && normalized.startsWith(`${commonRoot}/`)
    ? normalized.slice(commonRoot.length + 1)
    : normalized;
};

const fileInfo = (path: string, file: File): AltairBrowserWorkspaceFile =>
  Object.freeze({
    path,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  });

const fingerprint = (file: AltairBrowserWorkspaceFile): string =>
  `${file.size}:${file.lastModified}:${file.type}`;

const snapshot = (
  id: string,
  name: string,
  source: AltairBrowserWorkspaceSource,
  revision: number,
  entries: ReadonlyMap<string, WorkspaceEntry>,
): AltairBrowserWorkspaceSnapshot =>
  Object.freeze({
    id,
    name,
    source,
    revision,
    files: Object.freeze(
      [...entries.values()]
        .map(({ info }) => info)
        .sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
    ),
  });

const emptySnapshot = (revision = 0): AltairBrowserWorkspaceSnapshot =>
  snapshot("", "", "empty", revision, new Map());

const toFiles = (values: Iterable<File> | ArrayLike<File>): readonly File[] => {
  if (!values || typeof values !== "object") {
    throw new TypeError("Workspace files must be iterable or array-like");
  }
  const iterable = values as Partial<Iterable<File>>;
  const files =
    typeof iterable[Symbol.iterator] === "function"
      ? [...(values as Iterable<File>)]
      : Array.from(values as ArrayLike<File>);
  if (files.some((file) => !fileLike(file))) {
    throw new TypeError("Workspace selection contains an invalid File");
  }
  return files;
};

const checkLimit = (
  state: CollectState,
  file: File,
  limits: WorkspaceLimits,
): void => {
  state.count += 1;
  state.totalBytes += file.size;
  if (state.count > limits.maxFiles) {
    throw new RangeError(
      `Workspace contains more than ${limits.maxFiles} files`,
    );
  }
  if (state.totalBytes > limits.maxTotalBytes) {
    throw new RangeError(`Workspace exceeds ${limits.maxTotalBytes} bytes`);
  }
};

const hiddenPath = (path: string): boolean =>
  path.split("/").some((segment) => segment.startsWith("."));

const addEntry = (
  target: Map<string, WorkspaceEntry>,
  path: string,
  file: File,
  limits: WorkspaceLimits,
  state: CollectState,
  handle?: BrowserWorkspaceFileHandle,
): void => {
  if (!limits.includeHidden && hiddenPath(path)) return;
  if (target.has(path)) {
    throw new Error(`Workspace path is duplicated: ${path}`);
  }
  checkLimit(state, file, limits);
  target.set(path, {
    info: fileInfo(path, file),
    file,
    ...(handle === undefined ? {} : { handle }),
  });
};

const collectFiles = (
  files: readonly File[],
  limits: WorkspaceLimits,
): Map<string, WorkspaceEntry> => {
  const result = new Map<string, WorkspaceEntry>();
  const state: CollectState = { count: 0, totalBytes: 0 };
  const commonRoot = fileInputRoot(files);
  for (const file of files) {
    addEntry(result, filePath(file, commonRoot), file, limits, state);
  }
  return result;
};

const directoryChildren = async function* (
  directory: BrowserWorkspaceDirectoryHandle,
): AsyncGenerator<
  readonly [
    string,
    BrowserWorkspaceFileHandle | BrowserWorkspaceDirectoryHandle,
  ]
> {
  if (typeof directory.entries === "function") {
    for await (const entry of directory.entries()) yield entry;
    return;
  }
  if (typeof directory.values === "function") {
    for await (const handle of directory.values()) {
      yield [handle.name, handle] as const;
    }
    return;
  }
  throw new TypeError(`Directory handle ${directory.name} is not iterable`);
};

const fileHandle = (
  handle: BrowserWorkspaceFileHandle | BrowserWorkspaceDirectoryHandle,
): handle is BrowserWorkspaceFileHandle =>
  typeof (handle as BrowserWorkspaceFileHandle).getFile === "function";

const collectDirectory = async (
  root: BrowserWorkspaceDirectoryHandle,
  limits: WorkspaceLimits,
  signal: AbortSignal,
): Promise<Map<string, WorkspaceEntry>> => {
  const result = new Map<string, WorkspaceEntry>();
  const state: CollectState = { count: 0, totalBytes: 0 };
  const visit = async (
    directory: BrowserWorkspaceDirectoryHandle,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    throwIfAborted(signal);
    if (depth > limits.maxDepth) {
      throw new RangeError(
        `Workspace directory depth exceeds ${limits.maxDepth}`,
      );
    }
    for await (const [rawName, handle] of directoryChildren(directory)) {
      throwIfAborted(signal);
      const name =
        typeof rawName === "string" && rawName.trim() ? rawName : handle.name;
      const path = normalizeBrowserWorkspacePath(
        prefix ? `${prefix}/${name}` : name,
      );
      if (!limits.includeHidden && hiddenPath(path)) continue;
      if (fileHandle(handle)) {
        const file = await settleWithAbort(handle.getFile(), signal);
        if (!fileLike(file)) {
          throw new TypeError(
            `Workspace handle returned an invalid File: ${path}`,
          );
        }
        addEntry(result, path, file, limits, state, handle);
      } else {
        if (limits.ignoredDirectoryNames.has(name.toLocaleLowerCase())) {
          continue;
        }
        await visit(handle, path, depth + 1);
      }
    }
  };
  await visit(root, "", 0);
  return result;
};

const ensureReadPermission = async (
  handle: BrowserWorkspaceDirectoryHandle,
  signal: AbortSignal,
  requestPermission = true,
): Promise<void> => {
  throwIfAborted(signal);
  const descriptor = { mode: "read" } as const;
  const current = handle.queryPermission
    ? await settleWithAbort(handle.queryPermission(descriptor), signal)
    : "granted";
  if (current === "granted") return;
  const requested =
    requestPermission && handle.requestPermission
      ? await settleWithAbort(handle.requestPermission(descriptor), signal)
      : current;
  if (requested !== "granted") {
    throw new DOMException(
      "Workspace read permission was denied",
      "NotAllowedError",
    );
  }
};

const workspacePermission = async (
  handle: BrowserWorkspaceDirectoryHandle,
  mode: "read" | "readwrite",
  request: boolean,
  signal: AbortSignal,
): Promise<"granted" | "denied" | "prompt"> => {
  throwIfAborted(signal);
  const descriptor = { mode } as const;
  const current = handle.queryPermission
    ? await settleWithAbort(handle.queryPermission(descriptor), signal)
    : "granted";
  if (current === "granted" || !request || !handle.requestPermission) {
    return current;
  }
  return settleWithAbort(handle.requestPermission(descriptor), signal);
};

const ensureWritePermission = async (
  handle: BrowserWorkspaceDirectoryHandle | BrowserWorkspaceFileHandle,
  signal: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const descriptor = { mode: "readwrite" } as const;
  const current = handle.queryPermission
    ? await settleWithAbort(handle.queryPermission(descriptor), signal)
    : "granted";
  if (current === "granted") return;
  const requested = handle.requestPermission
    ? await settleWithAbort(handle.requestPermission(descriptor), signal)
    : current;
  if (requested !== "granted") {
    throw new DOMException(
      "Workspace write permission was denied",
      "NotAllowedError",
    );
  }
};

const writeDataBytes = (data: AltairBrowserWorkspaceWriteData): number => {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new TypeError("Workspace write data must be text, a Blob, or a buffer");
};

const mapsEqual = (
  left: ReadonlyMap<string, WorkspaceEntry>,
  right: ReadonlyMap<string, WorkspaceEntry>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [path, entry] of left) {
    const other = right.get(path);
    if (!other || fingerprint(entry.info) !== fingerprint(other.info)) {
      return false;
    }
  }
  return true;
};

export class BrowserWorkspaceService implements AltairBrowserWorkspaceService {
  private readonly environment: BrowserWorkspaceEnvironment;
  private readonly limits: WorkspaceLimits;
  private readonly persistence:
    BrowserWorkspaceDirectoryPersistence | undefined;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<AltairBrowserWorkspaceListener>();
  private readonly watchers = new Set<() => void>();
  private readonly urls = new Map<string, ObjectUrlEntry>();
  private entries = new Map<string, WorkspaceEntry>();
  private root: BrowserWorkspaceDirectoryHandle | undefined;
  private state = emptySnapshot();
  private generation = 0;
  private disposed = false;

  constructor(options: CreateAltairBrowserWorkspaceOptions = {}) {
    this.environment =
      options.environment ?? createBrowserWorkspaceEnvironment();
    this.limits = normalizeLimits(options);
    this.persistence = options.persistence;
  }

  get current(): AltairBrowserWorkspaceSnapshot {
    return this.state;
  }

  get capabilities(): AltairBrowserWorkspaceCapabilities {
    return Object.freeze({
      directoryPicker:
        typeof this.environment.showDirectoryPicker === "function",
      openFilePicker: typeof this.environment.showOpenFilePicker === "function",
      fileInput: typeof this.environment.pickWithInput === "function",
      objectUrls:
        typeof this.environment.createObjectURL === "function" &&
        typeof this.environment.revokeObjectURL === "function",
      writable:
        [...this.entries.values()].some(
          ({ handle }) => typeof handle?.createWritable === "function",
        ) || typeof this.root?.getFileHandle === "function",
    });
  }

  get directory(): BrowserWorkspaceDirectoryHandle | undefined {
    return this.root;
  }

  async persistedDirectory(): Promise<
    PersistedBrowserWorkspaceDirectory | undefined
  > {
    this.assertActive();
    return this.persistence?.load();
  }

  async rememberDirectory(
    directory = this.root,
    name = directory?.name ?? this.state.name,
  ): Promise<PersistedBrowserWorkspaceDirectory> {
    this.assertActive();
    if (!this.persistence) {
      throw new DOMException(
        "Workspace directory persistence is unavailable",
        "NotSupportedError",
      );
    }
    if (!directory) {
      throw new DOMException(
        "There is no directory handle to remember",
        "InvalidStateError",
      );
    }
    const persisted = Object.freeze({
      handle: directory,
      name: name.trim() || directory.name,
      updatedAt: this.environment.now(),
    });
    await this.persistence.save(persisted);
    return persisted;
  }

  async forgetDirectory(): Promise<void> {
    this.assertActive();
    await this.persistence?.clear();
  }

  async pickDirectory(
    options: AltairBrowserWorkspacePickOptions = {},
  ): Promise<AltairBrowserWorkspaceSnapshot> {
    this.assertActive();
    const generation = ++this.generation;
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      throwIfAborted(linked.signal);
      if (this.environment.showDirectoryPicker) {
        const root = await settleWithAbort(
          this.environment.showDirectoryPicker(options.pickerOptions),
          linked.signal,
        );
        await ensureReadPermission(root, linked.signal);
        const entries = await collectDirectory(
          root,
          this.limits,
          linked.signal,
        );
        this.assertGeneration(generation, linked.signal);
        return this.replace(
          options.name?.trim() || root.name,
          "directory-handle",
          entries,
          root,
        );
      }
      if (!this.environment.pickWithInput) {
        throw new DOMException(
          "Directory selection is unavailable",
          "NotSupportedError",
        );
      }
      const files = await settleWithAbort(
        this.environment.pickWithInput(
          { directory: true, multiple: true },
          linked.signal,
        ),
        linked.signal,
      );
      if (!files.length) {
        throw new DOMException("No workspace selected", "AbortError");
      }
      const entries = collectFiles(files, this.limits);
      this.assertGeneration(generation, linked.signal);
      return this.replace(
        options.name?.trim() || directoryName(files) || "Workspace",
        "file-input",
        entries,
      );
    } finally {
      linked.dispose();
    }
  }

  async connectDirectory(
    handle: BrowserWorkspaceDirectoryHandle,
    options: AltairBrowserWorkspaceConnectOptions = {},
  ): Promise<AltairBrowserWorkspaceSnapshot> {
    this.assertActive();
    if (
      !handle ||
      typeof handle !== "object" ||
      typeof handle.name !== "string" ||
      (!handle.entries && !handle.values)
    ) {
      throw new TypeError("Workspace directory handle is invalid");
    }
    const generation = ++this.generation;
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      await ensureReadPermission(
        handle,
        linked.signal,
        options.requestPermission === true,
      );
      const entries = await collectDirectory(
        handle,
        this.limits,
        linked.signal,
      );
      this.assertGeneration(generation, linked.signal);
      return this.replace(
        options.name?.trim() || handle.name,
        "directory-handle",
        entries,
        handle,
      );
    } finally {
      linked.dispose();
    }
  }

  async permission(
    mode: "read" | "readwrite",
    options: AltairBrowserWorkspaceReadOptions & {
      readonly request?: boolean;
    } = {},
  ): Promise<"granted" | "denied" | "prompt"> {
    this.assertActive();
    const root = this.root;
    if (!root || this.state.source !== "directory-handle") {
      return "denied";
    }
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      return await workspacePermission(
        root,
        mode,
        options.request === true,
        linked.signal,
      );
    } finally {
      linked.dispose();
    }
  }

  async pickFiles(
    options: AltairBrowserWorkspacePickOptions = {},
  ): Promise<AltairBrowserWorkspaceSnapshot> {
    this.assertActive();
    const generation = ++this.generation;
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      throwIfAborted(linked.signal);
      if (this.environment.showOpenFilePicker) {
        const handles = await settleWithAbort(
          this.environment.showOpenFilePicker(options.pickerOptions),
          linked.signal,
        );
        if (!handles.length) {
          throw new DOMException("No files selected", "AbortError");
        }
        const entries = new Map<string, WorkspaceEntry>();
        const state: CollectState = { count: 0, totalBytes: 0 };
        for (const handle of handles) {
          throwIfAborted(linked.signal);
          const file = await settleWithAbort(handle.getFile(), linked.signal);
          if (!fileLike(file)) {
            throw new TypeError(
              `Workspace handle returned an invalid File: ${handle.name}`,
            );
          }
          addEntry(
            entries,
            normalizeBrowserWorkspacePath(handle.name || file.name),
            file,
            this.limits,
            state,
            handle,
          );
        }
        this.assertGeneration(generation, linked.signal);
        return this.replace(
          options.name?.trim() || "Files",
          "file-handles",
          entries,
        );
      }
      if (!this.environment.pickWithInput) {
        throw new DOMException(
          "File selection is unavailable",
          "NotSupportedError",
        );
      }
      const files = await settleWithAbort(
        this.environment.pickWithInput({ multiple: true }, linked.signal),
        linked.signal,
      );
      if (!files.length) {
        throw new DOMException("No files selected", "AbortError");
      }
      const entries = collectFiles(files, this.limits);
      this.assertGeneration(generation, linked.signal);
      return this.replace(
        options.name?.trim() || "Files",
        "file-input",
        entries,
      );
    } finally {
      linked.dispose();
    }
  }

  async ingestFiles(
    files: Iterable<File> | ArrayLike<File>,
    options: AltairBrowserWorkspaceIngestOptions = {},
  ): Promise<AltairBrowserWorkspaceSnapshot> {
    this.assertActive();
    const generation = ++this.generation;
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      throwIfAborted(linked.signal);
      const values = toFiles(files);
      if (!values.length) {
        throw new TypeError("Workspace selection contains no files");
      }
      const entries = collectFiles(values, this.limits);
      this.assertGeneration(generation, linked.signal);
      return this.replace(
        options.name?.trim() || directoryName(values) || "Files",
        "file-input",
        entries,
      );
    } finally {
      linked.dispose();
    }
  }

  async refresh(
    options: AltairBrowserWorkspaceReadOptions = {},
  ): Promise<AltairBrowserWorkspaceSnapshot> {
    this.assertActive();
    const root = this.root;
    const workspaceId = this.state.id;
    if (!root || this.state.source !== "directory-handle") {
      return this.state;
    }
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      await ensureReadPermission(root, linked.signal);
      const entries = await collectDirectory(root, this.limits, linked.signal);
      throwIfAborted(linked.signal);
      if (this.root !== root || this.state.id !== workspaceId) {
        return this.state;
      }
      if (mapsEqual(this.entries, entries)) return this.state;
      this.revokeChangedUrls(entries);
      this.entries = entries;
      this.state = snapshot(
        this.state.id,
        this.state.name,
        this.state.source,
        this.state.revision + 1,
        entries,
      );
      this.emit({ type: "refresh", snapshot: this.state });
      return this.state;
    } finally {
      linked.dispose();
    }
  }

  match(reference: string): AltairBrowserWorkspaceFile | undefined {
    this.assertActive();
    let normalized: string;
    try {
      normalized = normalizeBrowserWorkspacePath(reference);
    } catch {
      return undefined;
    }
    const exact = this.entries.get(normalized);
    if (exact) return exact.info;
    if (normalized.includes("/")) return undefined;
    const candidates = [...this.entries.values()].filter(
      ({ info }) => info.name === normalized,
    );
    return candidates.length === 1 ? candidates[0]!.info : undefined;
  }

  async file(
    reference: string,
    options: AltairBrowserWorkspaceReadOptions = {},
  ): Promise<File> {
    this.assertActive();
    const info = this.match(reference);
    if (!info)
      throw new RangeError(`Workspace file does not exist: ${reference}`);
    const entry = this.entries.get(info.path)!;
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      throwIfAborted(linked.signal);
      const file = entry.handle
        ? await settleWithAbort(entry.handle.getFile(), linked.signal)
        : entry.file;
      if (!fileLike(file)) {
        throw new TypeError(`Workspace file is invalid: ${info.path}`);
      }
      return file;
    } finally {
      linked.dispose();
    }
  }

  async read(
    reference: string,
    options: AltairBrowserWorkspaceReadOptions = {},
  ): Promise<Uint8Array> {
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      const file = await this.file(reference, { signal: linked.signal });
      const bytes = await settleWithAbort(file.arrayBuffer(), linked.signal);
      return new Uint8Array(bytes);
    } finally {
      linked.dispose();
    }
  }

  async write(
    reference: string,
    data: AltairBrowserWorkspaceWriteData,
    options: AltairBrowserWorkspaceWriteOptions = {},
  ): Promise<AltairBrowserWorkspaceFile> {
    this.assertActive();
    const path = normalizeBrowserWorkspacePath(reference);
    if (!this.limits.includeHidden && hiddenPath(path)) {
      throw new TypeError(`Workspace path is excluded: ${path}`);
    }
    const existing = this.entries.get(path);
    if (!existing && options.create !== true) {
      throw new RangeError(`Workspace file does not exist: ${path}`);
    }
    const bytes = writeDataBytes(data);
    const currentBytes = [...this.entries.values()].reduce(
      (total, entry) => total + entry.info.size,
      0,
    );
    const projectedBytes = currentBytes - (existing?.info.size ?? 0) + bytes;
    if (projectedBytes > this.limits.maxTotalBytes) {
      throw new RangeError(
        `Workspace contents exceed ${this.limits.maxTotalBytes} bytes`,
      );
    }
    const generation = this.generation;
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    let writable: BrowserWorkspaceWritable | undefined;
    try {
      const handle = await this.resolveWritableHandle(
        path,
        options.create === true,
        linked.signal,
      );
      writable = await settleWithAbort(handle.createWritable!(), linked.signal);
      await settleWithAbort(writable.write(data), linked.signal);
      await settleWithAbort(writable.close(), linked.signal);
      writable = undefined;
      this.assertGeneration(generation, linked.signal);
      const file = await settleWithAbort(handle.getFile(), linked.signal);
      if (!fileLike(file)) {
        throw new TypeError(`Workspace file is invalid after writing: ${path}`);
      }
      const next = new Map(this.entries);
      next.set(path, {
        info: fileInfo(path, file),
        file,
        handle,
      });
      this.revokeChangedUrls(next);
      this.entries = next;
      this.state = snapshot(
        this.state.id,
        this.state.name,
        this.state.source,
        this.state.revision + 1,
        next,
      );
      this.emit({ type: "refresh", snapshot: this.state });
      return this.entries.get(path)!.info;
    } catch (error) {
      await writable?.abort?.().catch(() => undefined);
      throw error;
    } finally {
      linked.dispose();
    }
  }

  async url(
    reference: string,
    options: AltairBrowserWorkspaceReadOptions = {},
  ): Promise<string> {
    this.assertActive();
    if (
      !this.environment.createObjectURL ||
      !this.environment.revokeObjectURL
    ) {
      throw new DOMException(
        "Object URLs are unavailable",
        "NotSupportedError",
      );
    }
    const linked = linkAbortSignals([this.controller.signal, options.signal]);
    try {
      throwIfAborted(linked.signal);
      const info = this.match(reference);
      if (!info) {
        throw new RangeError(`Workspace file does not exist: ${reference}`);
      }
      const entry = this.entries.get(info.path)!;
      const file = await this.file(info.path, { signal: linked.signal });
      throwIfAborted(linked.signal);
      if (this.entries.get(info.path) !== entry) {
        throw new DOMException(
          "Workspace file changed while its URL was being created",
          "AbortError",
        );
      }
      const currentFingerprint = `${file.size}:${file.lastModified}:${file.type}`;
      const cached = this.urls.get(info.path);
      if (cached?.fingerprint === currentFingerprint) return cached.url;
      if (cached) this.environment.revokeObjectURL(cached.url);
      const url = this.environment.createObjectURL(file);
      this.urls.set(info.path, {
        fingerprint: currentFingerprint,
        url,
      });
      return url;
    } finally {
      linked.dispose();
    }
  }

  subscribe(listener: AltairBrowserWorkspaceListener): () => void {
    this.assertActive();
    if (typeof listener !== "function") {
      throw new TypeError("Workspace listener must be a function");
    }
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  watch(
    options: AltairBrowserWorkspaceWatchOptions = {},
  ): AltairBrowserWorkspaceDisposable {
    this.assertActive();
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (!this.root || this.state.source !== "directory-handle") {
      throw new Error("Only directory-handle workspaces can be watched");
    }
    const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_WATCH_INTERVAL_MS) {
      throw new RangeError(
        `Workspace watch interval must be at least ${MIN_WATCH_INTERVAL_MS}ms`,
      );
    }
    const controller = new AbortController();
    const linked = linkAbortSignals([
      this.controller.signal,
      options.signal,
      controller.signal,
    ]);
    let running = false;
    let active = true;
    const tick = () => {
      if (running || linked.signal.aborted) return;
      running = true;
      void this.refresh({ signal: linked.signal })
        .catch((error: unknown) => {
          if (!aborted(error)) {
            this.emit({
              type: "error",
              snapshot: this.state,
              error,
            });
          }
        })
        .finally(() => {
          running = false;
        });
    };
    let token: unknown;
    try {
      token = this.environment.setInterval(tick, intervalMs);
    } catch (error) {
      linked.dispose();
      throw error;
    }
    const dispose = () => {
      if (!active) return;
      active = false;
      controller.abort(
        new DOMException("Workspace watcher disposed", "AbortError"),
      );
      linked.dispose();
      options.signal?.removeEventListener("abort", dispose);
      this.environment.clearInterval(token);
      this.watchers.delete(dispose);
    };
    this.watchers.add(dispose);
    if (options.signal) {
      options.signal.addEventListener("abort", dispose, { once: true });
    }
    if (linked.signal.aborted) dispose();
    return Object.freeze({ dispose });
  }

  clear(): void {
    this.assertActive();
    this.generation += 1;
    const revision = this.state.revision + 1;
    this.revokeAllUrls();
    this.entries.clear();
    this.root = undefined;
    this.state = emptySnapshot(revision);
    for (const dispose of [...this.watchers]) dispose();
    this.emit({ type: "clear", snapshot: this.state });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.controller.abort(
      new DOMException("Browser workspace disposed", "AbortError"),
    );
    for (const dispose of [...this.watchers]) dispose();
    this.revokeAllUrls();
    void this.persistence?.dispose?.();
    this.entries.clear();
    this.root = undefined;
    this.state = emptySnapshot(this.state.revision + 1);
    this.emit({ type: "clear", snapshot: this.state });
    this.listeners.clear();
  }

  private replace(
    name: string,
    source: Exclude<AltairBrowserWorkspaceSource, "empty">,
    entries: Map<string, WorkspaceEntry>,
    root?: BrowserWorkspaceDirectoryHandle,
  ): AltairBrowserWorkspaceSnapshot {
    this.revokeAllUrls();
    for (const dispose of [...this.watchers]) dispose();
    this.entries = entries;
    this.root = root;
    this.state = snapshot(
      this.workspaceId(),
      name || "Workspace",
      source,
      1,
      entries,
    );
    this.emit({ type: "replace", snapshot: this.state });
    return this.state;
  }

  private revokeChangedUrls(next: ReadonlyMap<string, WorkspaceEntry>): void {
    if (!this.environment.revokeObjectURL) return;
    for (const [path, cached] of [...this.urls]) {
      const entry = next.get(path);
      if (!entry || fingerprint(entry.info) !== cached.fingerprint) {
        this.environment.revokeObjectURL(cached.url);
        this.urls.delete(path);
      }
    }
  }

  private revokeAllUrls(): void {
    if (this.environment.revokeObjectURL) {
      for (const { url } of this.urls.values()) {
        this.environment.revokeObjectURL(url);
      }
    }
    this.urls.clear();
  }

  private emit(
    event: Omit<AltairBrowserWorkspaceEvent, "snapshot"> & {
      readonly snapshot?: AltairBrowserWorkspaceSnapshot;
    },
  ): void {
    const value = Object.freeze({
      ...event,
      snapshot: event.snapshot ?? this.state,
    }) as AltairBrowserWorkspaceEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A view listener must not corrupt workspace ownership.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new ReferenceError("Browser workspace service is disposed");
    }
  }

  private async resolveWritableHandle(
    path: string,
    create: boolean,
    signal: AbortSignal,
  ): Promise<BrowserWorkspaceFileHandle> {
    const existing = this.entries.get(path)?.handle;
    if (existing) {
      await ensureWritePermission(existing, signal);
      if (typeof existing.createWritable !== "function") {
        throw new DOMException(
          `Workspace file is read only: ${path}`,
          "NotSupportedError",
        );
      }
      return existing;
    }
    const root = this.root;
    if (!root || typeof root.getFileHandle !== "function") {
      throw new DOMException(
        "The active workspace cannot create files",
        "NotSupportedError",
      );
    }
    await ensureWritePermission(root, signal);
    const parts = path.split("/");
    if (parts.length - 1 > this.limits.maxDepth) {
      throw new RangeError(
        `Workspace directory depth exceeds ${this.limits.maxDepth}`,
      );
    }
    let directory = root;
    if (
      parts.length > 1 &&
      typeof directory.getDirectoryHandle !== "function"
    ) {
      throw new DOMException(
        "The active workspace cannot create nested files",
        "NotSupportedError",
      );
    }
    for (const segment of parts.slice(0, -1)) {
      directory = await settleWithAbort(
        directory.getDirectoryHandle!(segment, { create }),
        signal,
      );
    }
    const handle = await settleWithAbort(
      directory.getFileHandle!(parts.at(-1)!, { create }),
      signal,
    );
    if (typeof handle.createWritable !== "function") {
      throw new DOMException(
        `Workspace file is read only: ${path}`,
        "NotSupportedError",
      );
    }
    return handle;
  }

  private assertGeneration(generation: number, signal: AbortSignal): void {
    throwIfAborted(signal);
    if (generation !== this.generation) {
      throw new DOMException(
        "Browser workspace selection was superseded",
        "AbortError",
      );
    }
  }

  private workspaceId(): string {
    if (this.environment.randomUUID) {
      return `workspace-${this.environment.randomUUID()}`;
    }
    fallbackId += 1;
    return `workspace-${this.environment.now()}-${fallbackId}`;
  }
}

const directoryName = (files: readonly File[]): string | undefined => {
  return fileInputRoot(files);
};

const fileInputRoot = (files: readonly File[]): string | undefined => {
  let commonRoot: string | undefined;
  for (const file of files) {
    const relative = (file as File & { readonly webkitRelativePath?: string })
      .webkitRelativePath;
    if (!relative?.trim()) return undefined;
    const segments = relative.replaceAll("\\", "/").split("/");
    const candidate = segments[0]?.trim();
    if (!candidate || segments.length < 2) return undefined;
    if (commonRoot === undefined) commonRoot = candidate;
    else if (commonRoot !== candidate) return undefined;
  }
  return commonRoot;
};
