export type BrowserWorkspacePermissionState = "granted" | "denied" | "prompt";

export interface BrowserWorkspaceWritable {
  write(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface BrowserWorkspaceFileHandle {
  readonly kind?: "file";
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission?(descriptor?: Readonly<{ mode: "read" | "readwrite" }>): Promise<BrowserWorkspacePermissionState>;
  requestPermission?(descriptor?: Readonly<{ mode: "read" | "readwrite" }>): Promise<BrowserWorkspacePermissionState>;
  createWritable?(): Promise<BrowserWorkspaceWritable>;
}

export interface BrowserWorkspaceDirectoryHandle {
  readonly kind?: "directory";
  readonly name: string;
  values?(): AsyncIterable<BrowserWorkspaceFileHandle | BrowserWorkspaceDirectoryHandle>;
  entries?(): AsyncIterable<readonly [string, BrowserWorkspaceFileHandle | BrowserWorkspaceDirectoryHandle]>;
  queryPermission?(descriptor?: Readonly<{ mode: "read" | "readwrite" }>): Promise<BrowserWorkspacePermissionState>;
  requestPermission?(descriptor?: Readonly<{ mode: "read" | "readwrite" }>): Promise<BrowserWorkspacePermissionState>;
  getFileHandle?(name: string, options?: Readonly<{ create?: boolean }>): Promise<BrowserWorkspaceFileHandle>;
  getDirectoryHandle?(name: string, options?: Readonly<{ create?: boolean }>): Promise<BrowserWorkspaceDirectoryHandle>;
}

export interface BrowserWorkspaceInputOptions {
  readonly accept?: string;
  readonly directory?: boolean;
  readonly multiple?: boolean;
}

export interface BrowserWorkspaceEnvironment {
  readonly showDirectoryPicker?: (
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<BrowserWorkspaceDirectoryHandle>;
  readonly showOpenFilePicker?: (
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<readonly BrowserWorkspaceFileHandle[]>;
  readonly pickWithInput?: (options: BrowserWorkspaceInputOptions, signal: AbortSignal) => Promise<readonly File[]>;
  readonly createObjectURL?: (file: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly setInterval: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval: (token: unknown) => void;
  readonly randomUUID?: () => string;
  readonly now: () => number;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("Browser workspace selection aborted", "AbortError");

const inputFiles = (files: FileList | null): readonly File[] => (files ? Array.from(files) : []);

export const pickBrowserFilesWithInput = (
  options: BrowserWorkspaceInputOptions,
  signal: AbortSignal,
): Promise<readonly File[]> => {
  if (typeof globalThis.document === "undefined" || typeof globalThis.document.createElement !== "function") {
    return Promise.reject(new DOMException("File input is unavailable", "NotSupportedError"));
  }
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<readonly File[]>((resolve, reject) => {
    const input = globalThis.document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple !== false;
    input.accept = options.accept ?? "";
    input.style.display = "none";
    if (options.directory) {
      input.webkitdirectory = true;
      input.setAttribute("directory", "");
    }

    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { readonly files: readonly File[] } | { readonly error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      globalThis.window?.removeEventListener("focus", onFocus);
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      input.remove();
      if ("error" in result) reject(result.error);
      else resolve(result.files);
    };
    const onAbort = () => finish({ error: abortReason(signal) });
    const onChange = () => finish({ files: inputFiles(input.files) });
    const onCancel = () =>
      finish({
        error: new DOMException("File selection cancelled", "AbortError"),
      });
    const onFocus = () => {
      focusTimer = setTimeout(() => {
        if (!settled && !input.files?.length) onCancel();
      }, 0);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    input.addEventListener("change", onChange, { once: true });
    input.addEventListener("cancel", onCancel, { once: true });
    globalThis.window?.addEventListener("focus", onFocus, { once: true });
    globalThis.document.body?.append(input);
    try {
      input.click();
    } catch (error) {
      finish({ error });
    }
  });
};

type PickerGlobals = typeof globalThis & {
  showDirectoryPicker?: BrowserWorkspaceEnvironment["showDirectoryPicker"];
  showOpenFilePicker?: BrowserWorkspaceEnvironment["showOpenFilePicker"];
};

export const createBrowserWorkspaceEnvironment = (): BrowserWorkspaceEnvironment => {
  const scope = globalThis as PickerGlobals;
  const createObjectURL =
    typeof globalThis.URL?.createObjectURL === "function"
      ? globalThis.URL.createObjectURL.bind(globalThis.URL)
      : undefined;
  const revokeObjectURL =
    typeof globalThis.URL?.revokeObjectURL === "function"
      ? globalThis.URL.revokeObjectURL.bind(globalThis.URL)
      : undefined;
  return Object.freeze({
    ...(typeof scope.showDirectoryPicker === "function"
      ? {
          showDirectoryPicker: scope.showDirectoryPicker.bind(scope),
        }
      : {}),
    ...(typeof scope.showOpenFilePicker === "function"
      ? { showOpenFilePicker: scope.showOpenFilePicker.bind(scope) }
      : {}),
    ...(typeof globalThis.document?.createElement === "function" ? { pickWithInput: pickBrowserFilesWithInput } : {}),
    ...(createObjectURL === undefined ? {} : { createObjectURL }),
    ...(revokeObjectURL === undefined ? {} : { revokeObjectURL }),
    setInterval: (callback: () => void, intervalMs: number) => globalThis.setInterval(callback, intervalMs),
    clearInterval: (token: unknown) => globalThis.clearInterval(token as ReturnType<typeof globalThis.setInterval>),
    ...(typeof globalThis.crypto?.randomUUID === "function"
      ? {
          randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto),
        }
      : {}),
    now: () => Date.now(),
  });
};
