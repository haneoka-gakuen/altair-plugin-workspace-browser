import { defineAltairService } from "@haneoka/altair/plugins";
import type {
  BrowserWorkspaceDirectoryHandle,
  BrowserWorkspacePermissionState,
} from "./environment.js";
import type {
  BrowserWorkspaceDirectoryPersistence,
  PersistedBrowserWorkspaceDirectory,
} from "./persistence.js";

export type AltairBrowserWorkspaceSource =
  "empty" | "directory-handle" | "file-handles" | "file-input";

export interface AltairBrowserWorkspaceFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
}

export interface AltairBrowserWorkspaceSnapshot {
  readonly id: string;
  readonly name: string;
  readonly source: AltairBrowserWorkspaceSource;
  readonly revision: number;
  readonly files: readonly AltairBrowserWorkspaceFile[];
}

export type AltairBrowserWorkspaceEventType =
  "replace" | "refresh" | "clear" | "error";

export interface AltairBrowserWorkspaceEvent {
  readonly type: AltairBrowserWorkspaceEventType;
  readonly snapshot: AltairBrowserWorkspaceSnapshot;
  readonly error?: unknown;
}

export type AltairBrowserWorkspaceListener = (
  event: AltairBrowserWorkspaceEvent,
) => void;

export interface AltairBrowserWorkspaceCapabilities {
  readonly directoryPicker: boolean;
  readonly openFilePicker: boolean;
  readonly fileInput: boolean;
  readonly objectUrls: boolean;
  readonly writable: boolean;
}

export interface AltairBrowserWorkspacePickOptions {
  readonly signal?: AbortSignal;
  readonly name?: string;
  readonly pickerOptions?: Readonly<Record<string, unknown>>;
}

export interface AltairBrowserWorkspaceConnectOptions extends AltairBrowserWorkspaceReadOptions {
  readonly name?: string;
  /**
   * Request read permission when it is not already granted. Restoring a
   * persisted handle normally leaves this false so only an explicit user
   * gesture can trigger a permission prompt.
   */
  readonly requestPermission?: boolean;
}

export interface AltairBrowserWorkspaceIngestOptions {
  readonly signal?: AbortSignal;
  readonly name?: string;
}

export interface AltairBrowserWorkspaceReadOptions {
  readonly signal?: AbortSignal;
}

export interface AltairBrowserWorkspaceWriteOptions extends AltairBrowserWorkspaceReadOptions {
  /** Create a missing file and intermediate directories when supported. */
  readonly create?: boolean;
}

export type AltairBrowserWorkspaceWriteData =
  string | Blob | ArrayBuffer | ArrayBufferView;

export interface AltairBrowserWorkspaceWatchOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
}

export interface AltairBrowserWorkspaceLimits {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly includeHidden?: boolean;
  readonly ignoredDirectoryNames?: readonly string[];
}

export interface AltairBrowserWorkspaceDisposable {
  dispose(): void | Promise<void>;
}

export interface AltairBrowserWorkspaceService extends AltairBrowserWorkspaceDisposable {
  readonly current: AltairBrowserWorkspaceSnapshot;
  readonly capabilities: AltairBrowserWorkspaceCapabilities;
  /** Active directory handle, if the workspace is backed by one. */
  readonly directory: BrowserWorkspaceDirectoryHandle | undefined;
  persistedDirectory(): Promise<PersistedBrowserWorkspaceDirectory | undefined>;
  rememberDirectory(
    directory?: BrowserWorkspaceDirectoryHandle,
    name?: string,
  ): Promise<PersistedBrowserWorkspaceDirectory>;
  forgetDirectory(): Promise<void>;
  pickDirectory(
    options?: AltairBrowserWorkspacePickOptions,
  ): Promise<AltairBrowserWorkspaceSnapshot>;
  /**
   * Connects a host-restored directory handle without bypassing workspace
   * limits, permission checks, cancellation, or resource ownership.
   */
  connectDirectory(
    handle: BrowserWorkspaceDirectoryHandle,
    options?: AltairBrowserWorkspaceConnectOptions,
  ): Promise<AltairBrowserWorkspaceSnapshot>;
  permission(
    mode: "read" | "readwrite",
    options?: AltairBrowserWorkspaceReadOptions & {
      readonly request?: boolean;
    },
  ): Promise<BrowserWorkspacePermissionState>;
  pickFiles(
    options?: AltairBrowserWorkspacePickOptions,
  ): Promise<AltairBrowserWorkspaceSnapshot>;
  ingestFiles(
    files: Iterable<File> | ArrayLike<File>,
    options?: AltairBrowserWorkspaceIngestOptions,
  ): Promise<AltairBrowserWorkspaceSnapshot>;
  refresh(
    options?: AltairBrowserWorkspaceReadOptions,
  ): Promise<AltairBrowserWorkspaceSnapshot>;
  match(reference: string): AltairBrowserWorkspaceFile | undefined;
  file(
    reference: string,
    options?: AltairBrowserWorkspaceReadOptions,
  ): Promise<File>;
  read(
    reference: string,
    options?: AltairBrowserWorkspaceReadOptions,
  ): Promise<Uint8Array>;
  write(
    reference: string,
    data: AltairBrowserWorkspaceWriteData,
    options?: AltairBrowserWorkspaceWriteOptions,
  ): Promise<AltairBrowserWorkspaceFile>;
  url(
    reference: string,
    options?: AltairBrowserWorkspaceReadOptions,
  ): Promise<string>;
  subscribe(listener: AltairBrowserWorkspaceListener): () => void;
  watch(
    options?: AltairBrowserWorkspaceWatchOptions,
  ): AltairBrowserWorkspaceDisposable;
  clear(): void;
}

export const ALTAIR_BROWSER_WORKSPACE_SERVICE =
  defineAltairService<AltairBrowserWorkspaceService>(
    "haneoka.altair.workspace.browser",
  );

export const ALTAIR_BROWSER_WORKSPACE_PLUGIN_ID =
  "haneoka.altair-workspace-browser" as const;

export type { BrowserWorkspaceDirectoryPersistence };
