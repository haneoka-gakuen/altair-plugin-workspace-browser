# Altair Workspace Browser

Opens and edits project folders with browser file-system APIs.

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-workspace-browser
```

```ts
await host.install(altairWorkspaceBrowserPlugin);
const workspace = host.service(ALTAIR_BROWSER_WORKSPACE_SERVICE);
await workspace?.pickDirectory();
await workspace?.write("scene/main.txt", source);
```

The optional IndexedDB adapter remembers directory handles between sessions. See the [security model](docs/SECURITY_MODEL.md) for permissions and file access behavior.

MPL-2.0.
