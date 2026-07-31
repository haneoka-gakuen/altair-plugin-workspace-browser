import type { JsonObject } from "@haneoka/altair/model";
import type {
  AltairAssetProviderContribution,
  AltairResolvedAsset,
} from "@haneoka/altair/plugins";
import type { AltairBrowserWorkspaceService } from "./contracts.js";

const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".css": "text/css",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
});

const mediaType = (path: string, declared: string): string | undefined => {
  if (declared.trim()) return declared.trim();
  const normalized = path.toLowerCase();
  const extension = Object.keys(MEDIA_TYPES).find((candidate) =>
    normalized.endsWith(candidate),
  );
  return extension ? MEDIA_TYPES[extension] : undefined;
};

const metadata = (
  path: string,
  size: number,
  lastModified: number,
): JsonObject => ({
  workspacePath: path,
  size,
  lastModified,
});

export const createBrowserWorkspaceAssetContribution = (
  workspace: AltairBrowserWorkspaceService,
): AltairAssetProviderContribution =>
  Object.freeze<AltairAssetProviderContribution>({
    id: "browser-workspace-assets",
    name: "Browser workspace assets",
    supports: ({ reference }) => (workspace.match(reference) ? 1 : 0),
    async resolve({ reference, signal }): Promise<
      AltairResolvedAsset | undefined
    > {
      const file = workspace.match(reference);
      if (!file) return undefined;
      const type = mediaType(file.path, file.type);
      if (workspace.capabilities.objectUrls) {
        return {
          id: file.path,
          source: await workspace.url(file.path, { signal }),
          ...(type === undefined ? {} : { mediaType: type }),
          metadata: metadata(file.path, file.size, file.lastModified),
        };
      }
      return {
        id: file.path,
        bytes: await workspace.read(file.path, { signal }),
        ...(type === undefined ? {} : { mediaType: type }),
        metadata: metadata(file.path, file.size, file.lastModified),
      };
    },
  });
