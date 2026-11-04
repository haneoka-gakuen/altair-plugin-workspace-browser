# Altair Workspace Browser

Altair Workspace Browser lets the [Altair](https://github.com/haneoka-gakuen/altair)
editor work on a real folder on your computer, straight from the browser. Pick
a project folder once and Altair reads scenes, images, audio and models from
it and saves your edits back to the same files — no upload, no server, no
copy to keep in sync. Changes you make in other programs show up in the
editor, and the folder can be reopened the next time without picking it again.

Where the browser cannot open folders, the same service falls back to picking
individual files or to a classic file input, so the editor still works — just
read-only.

## Install

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-workspace-browser
```

ESM only. Folder access uses the File System Access API (Chromium-based
browsers); other browsers use the file-input fallback.

The `./archive` export writes project and game ZIPs with bounded streaming reads.
Compressed entries use the browser's `CompressionStream("deflate-raw")`; fflate
writes ZIP headers, sizes and CRCs. Individual files stay below the 2 GB project
limit, and archive paths and entry counts are checked before writing.

## Use it in Altair

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import {
  ALTAIR_BROWSER_WORKSPACE_SERVICE,
  altairWorkspaceBrowserPlugin,
} from "@haneoka/altair-plugin-workspace-browser";

const host = new AltairPluginHost();
await host.install(altairWorkspaceBrowserPlugin);

const workspace = host.service(ALTAIR_BROWSER_WORKSPACE_SERVICE);
const snapshot = await workspace.pickDirectory(); // must run from a click or key press
const scene = new TextDecoder().decode(await workspace.read("game/scene/start.txt"));
await workspace.write("game/scene/start.txt", edited);
```

The plugin (`haneoka.altair-workspace-browser`) provides the workspace service
and an asset provider, so resource names in commands resolve to files in the
open folder.

## Opening a workspace

| Method                     | What it does                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `pickDirectory()`          | Shows the folder picker and reads the folder. Needs a user gesture. |
| `pickFiles()`              | Shows the file picker, or a file input where there is no picker.    |
| `ingestFiles(files)`       | Uses files you already have, for example from drag and drop.        |
| `connectDirectory(handle)` | Reconnects a folder handle restored by your app.                    |
| `refresh()` / `clear()`    | Re-read the source, or close it.                                    |

`workspace.capabilities` tells you what the current browser supports:
`directoryPicker`, `openFilePicker`, `fileInput`, `objectUrls` and `writable`.

Every method returns a **snapshot**: the workspace `id`, `name`, `source`
(`directory-handle`, `file-handles`, `file-input` or `empty`), a `revision`
that increases on every change, the file list (path, name, size, type,
modification time) and the directories.

## Reading and writing

| Method                                        | Description                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `match(path)`                                 | Finds a file in the snapshot.                                                   |
| `file(path)` / `read(path)`                   | The file as a `File` or as bytes.                                               |
| `url(path)`                                   | An object URL for previews; released when the workspace changes or is disposed. |
| `write(path, data, { create })`               | Writes text, a `Blob` or bytes. `create` makes missing folders.                 |
| `mkdir`, `exists`, `remove`, `rename`, `copy` | Available when the source is a writable folder.                                 |

`remove(path, { recursive, expected })` can be given the snapshot you backed
up; the folder is only deleted if its contents still match it exactly.

All methods accept an `AbortSignal`.

## Following changes on disk

```ts
const stop = workspace.subscribe(({ type, snapshot }) => {
  // type: "replace" | "refresh" | "clear" | "error"
});
const watcher = workspace.watch({ intervalMs: 1000 });
// later
watcher.dispose();
stop();
```

`watch` polls the folder every `intervalMs` (100 ms or more) and emits `refresh` when
files were added, removed or modified outside the editor.

## Remembering the folder

Pass a persistence adapter and the folder can be restored after a reload:

```ts
import {
  createAltairWorkspaceBrowserPlugin,
  createIndexedDbBrowserWorkspaceDirectoryPersistence,
} from "@haneoka/altair-plugin-workspace-browser";

await host.install(
  createAltairWorkspaceBrowserPlugin({ persistence: createIndexedDbBrowserWorkspaceDirectoryPersistence() }),
);

await workspace.rememberDirectory();
const saved = await workspace.persistedDirectory();
if (saved) await workspace.connectDirectory(saved.handle);
await workspace.forgetDirectory();
```

Nothing is remembered unless you install an adapter and call
`rememberDirectory`. Restoring a handle does not ask for permission on its
own; call `permission("read", { request: true })` from a user gesture when the
browser wants it confirmed again.

## Limits and safety

| Option                  | Default                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `maxDepth`              | 32 folder levels                                                       |
| `maxFiles`              | 20 000 files (and 20 000 folders)                                      |
| `maxTotalBytes`         | 8 GiB                                                                  |
| `includeHidden`         | `false` — dot-files are skipped                                        |
| `ignoredDirectoryNames` | `.git`, `.nuxt`, `.output`, `build`, `dist`, `node_modules`, `release` |

Pass them to `createAltairWorkspaceBrowserPlugin`. Paths are always relative
and normalized; absolute paths, `..`, drive letters and NUL bytes are
rejected, so a project file can never reach outside its folder. Read access is
only requested for the folder the user picked.

## License

MPL-2.0. See [LICENSE](LICENSE).
