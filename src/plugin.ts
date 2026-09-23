import { defineAltairPlugin } from "@haneoka/altair/plugins";
import { createBrowserWorkspaceAssetContribution } from "./assets.js";
import { ALTAIR_BROWSER_WORKSPACE_PLUGIN_ID, ALTAIR_BROWSER_WORKSPACE_SERVICE } from "./contracts.js";
import { BrowserWorkspaceService, type CreateAltairBrowserWorkspaceOptions } from "./workspace.js";

export type AltairWorkspaceBrowserPluginOptions = CreateAltairBrowserWorkspaceOptions;

export const createAltairWorkspaceBrowserPlugin = (options: AltairWorkspaceBrowserPluginOptions = {}) =>
  defineAltairPlugin({
    manifest: {
      id: ALTAIR_BROWSER_WORKSPACE_PLUGIN_ID,
      name: "Altair Browser Workspace",
      version: "0.1.0",
      apiVersion: 2,
      capabilities: ["assets", "services"],
    },
    setup(context) {
      const workspace = context.use(new BrowserWorkspaceService(options));
      context.provide(ALTAIR_BROWSER_WORKSPACE_SERVICE, workspace);
      context.contribute("asset", createBrowserWorkspaceAssetContribution(workspace), { priority: 100 });
    },
  });

export const altairWorkspaceBrowserPlugin = createAltairWorkspaceBrowserPlugin();

export default altairWorkspaceBrowserPlugin;
