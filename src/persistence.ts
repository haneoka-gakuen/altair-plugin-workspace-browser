import type { BrowserWorkspaceDirectoryHandle } from "./environment.js";

export interface PersistedBrowserWorkspaceDirectory {
  readonly handle: BrowserWorkspaceDirectoryHandle;
  readonly name: string;
  readonly updatedAt: number;
}

export interface BrowserWorkspaceDirectoryPersistence {
  load(): Promise<PersistedBrowserWorkspaceDirectory | undefined>;
  save(directory: PersistedBrowserWorkspaceDirectory): Promise<void>;
  clear(): Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface IndexedDbBrowserWorkspaceDirectoryPersistenceOptions {
  readonly databaseName?: string;
  readonly databaseVersion?: number;
  readonly storeName?: string;
  readonly key?: IDBValidKey;
  readonly indexedDb?: IDBFactory;
}

const requestResult = <Value>(request: IDBRequest<Value>): Promise<Value> =>
  new Promise<Value>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });

const transactionCompletion = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () =>
        reject(
          transaction.error ?? new Error("IndexedDB transaction was aborted"),
        ),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () =>
        reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });

const persistedDirectory = (
  value: unknown,
): PersistedBrowserWorkspaceDirectory | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<PersistedBrowserWorkspaceDirectory>;
  if (
    !record.handle ||
    typeof record.handle !== "object" ||
    typeof record.handle.name !== "string" ||
    typeof record.name !== "string" ||
    !Number.isFinite(record.updatedAt)
  ) {
    return undefined;
  }
  return {
    handle: record.handle,
    name: record.name,
    updatedAt: Number(record.updatedAt),
  };
};

/**
 * Persists structured-cloneable File System Access handles. Hosts only choose
 * storage names and decide when a user action should replace or clear one.
 */
export class IndexedDbBrowserWorkspaceDirectoryPersistence implements BrowserWorkspaceDirectoryPersistence {
  private readonly indexedDb: IDBFactory | undefined;
  private readonly databaseName: string;
  private readonly databaseVersion: number;
  private readonly storeName: string;
  private readonly key: IDBValidKey;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private disposed = false;

  constructor(
    options: IndexedDbBrowserWorkspaceDirectoryPersistenceOptions = {},
  ) {
    this.indexedDb = options.indexedDb ?? globalThis.indexedDB;
    this.databaseName =
      options.databaseName?.trim() || "altair-browser-workspace-v1";
    this.databaseVersion = options.databaseVersion ?? 1;
    this.storeName = options.storeName?.trim() || "workspace";
    this.key = options.key ?? "active-directory";
    if (
      !Number.isSafeInteger(this.databaseVersion) ||
      this.databaseVersion <= 0
    ) {
      throw new RangeError("IndexedDB databaseVersion must be positive");
    }
  }

  async load(): Promise<PersistedBrowserWorkspaceDirectory | undefined> {
    const value = await this.withStore("readonly", (store) =>
      store.get(this.key),
    );
    return persistedDirectory(value);
  }

  async save(directory: PersistedBrowserWorkspaceDirectory): Promise<void> {
    const value = persistedDirectory(directory);
    if (!value) {
      throw new TypeError("Persisted workspace directory is invalid");
    }
    await this.withStore("readwrite", (store) => store.put(value, this.key));
  }

  async clear(): Promise<void> {
    await this.withStore("readwrite", (store) => store.delete(this.key));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = undefined;
  }

  private async withStore<Value>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<Value>,
  ): Promise<Value> {
    const database = await this.database();
    const transaction = database.transaction(this.storeName, mode);
    const result = await requestResult(
      action(transaction.objectStore(this.storeName)),
    );
    await transactionCompletion(transaction);
    return result;
  }

  private database(): Promise<IDBDatabase> {
    if (this.disposed) {
      return Promise.reject(
        new DOMException(
          "Browser workspace persistence is disposed",
          "InvalidStateError",
        ),
      );
    }
    if (!this.indexedDb) {
      return Promise.reject(
        new DOMException("IndexedDB is unavailable", "NotSupportedError"),
      );
    }
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb!.open(
        this.databaseName,
        this.databaseVersion,
      );
      request.addEventListener(
        "upgradeneeded",
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(this.storeName)) {
            database.createObjectStore(this.storeName);
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      });
      request.addEventListener(
        "error",
        () =>
          reject(request.error ?? new Error("IndexedDB could not be opened")),
        { once: true },
      );
      request.addEventListener(
        "blocked",
        () =>
          reject(
            new DOMException(
              "IndexedDB upgrade was blocked by another context",
              "InvalidStateError",
            ),
          ),
        { once: true },
      );
    });
    return this.databasePromise;
  }
}

export const createIndexedDbBrowserWorkspaceDirectoryPersistence = (
  options: IndexedDbBrowserWorkspaceDirectoryPersistenceOptions = {},
): BrowserWorkspaceDirectoryPersistence =>
  new IndexedDbBrowserWorkspaceDirectoryPersistence(options);
