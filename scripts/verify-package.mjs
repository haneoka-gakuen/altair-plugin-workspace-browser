import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const fail = (message) => {
  throw new Error(`Package verification failed: ${message}`);
};

if (manifest.name !== "@haneoka/altair-plugin-workspace-browser") {
  fail("package name must be @haneoka/altair-plugin-workspace-browser");
}
if (manifest.license !== "MPL-2.0") fail("license must be MPL-2.0");
if (manifest.private === true) fail("package cannot be private");
if (manifest.sideEffects !== false) fail("sideEffects must be false");
if (manifest.repository?.url !== "git+https://github.com/haneoka-gakuen/altair-plugin-workspace-browser.git") {
  fail("repository URL is not canonical");
}
if (manifest.publishConfig?.access !== "public") {
  fail("publishConfig.access must be public");
}
if (manifest.publishConfig?.provenance !== true) {
  fail("npm provenance must be enabled");
}
if (manifest.altair?.pluginApi !== 2) {
  fail("Altair plugin API must be 2");
}
if (JSON.stringify([...(manifest.altair?.capabilities ?? [])].sort()) !== JSON.stringify(["assets", "services"])) {
  fail("plugin capabilities must be assets and services");
}
if (JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) !== JSON.stringify(["fflate"])) {
  fail("fflate must be the only archive dependency");
}
if (Object.keys(manifest.optionalDependencies ?? {}).length > 0) {
  fail("optional runtime dependencies are not allowed");
}
if (JSON.stringify(Object.keys(manifest.peerDependencies ?? {}).sort()) !== JSON.stringify(["@haneoka/altair"])) {
  fail("@haneoka/altair must be the only peer dependency");
}

const insideRoot = (path) => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !fromRoot.startsWith(sep));
};

const collectTargets = (value) => {
  if (typeof value === "string") {
    return value.startsWith("./dist/") ? [value] : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectTargets);
};

const targets = new Set(
  [manifest.main, manifest.module, manifest.types, ...collectTargets(manifest.exports)].filter(
    (value) => typeof value === "string" && value.startsWith("./dist/"),
  ),
);
if (targets.size === 0) fail("manifest has no distribution targets");
for (const target of targets) {
  try {
    await access(resolve(root, target));
  } catch {
    fail(`manifest references missing output ${target}`);
  }
}

const forbiddenPath =
  /(?:^|\/)(?:character-models?|live2d|cubism|models?|runtime|sdk|vendor)(?:\/|$)|\.(?:moc|moc3|model3\.json|motion3\.json|physics3\.json|cdi3\.json|exp3\.json|wasm|node|dll|dylib|so|avif|bmp|gif|jpe?g|png|svg|webp|mp3|ogg|wav|m4a|mp4|webm)$/iu;
const ignoredRoots = new Set([".dependencies", ".git", "coverage", "dist", "node_modules"]);
const repositoryFiles = [];

const walkRepository = async (path, relativePath = "") => {
  if (!insideRoot(path)) fail(`path escapes repository: ${relativePath}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail(`symbolic link is not allowed: ${relativePath}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (!relativePath && ignoredRoots.has(entry)) continue;
      await walkRepository(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
    }
    return;
  }
  repositoryFiles.push(relativePath);
};

await walkRepository(root);
const forbiddenRepositoryFiles = repositoryFiles.filter(
  (path) => !path.startsWith("docs/brand/") && forbiddenPath.test(path),
);
if (forbiddenRepositoryFiles.length > 0) {
  fail(`restricted payload:\n${forbiddenRepositoryFiles.join("\n")}`);
}

const publishableFiles = [];
let publishableBytes = 0;
const walkPublishable = async (path, relativePath) => {
  if (!insideRoot(path)) fail(`publish path escapes repository: ${relativePath}`);
  const canonical = await realpath(path);
  if (!insideRoot(canonical)) {
    fail(`publish path resolves outside repository: ${relativePath}`);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    fail(`publish path is a symbolic link: ${relativePath}`);
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await walkPublishable(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
    }
    return;
  }
  const bytes = await readFile(path);
  if (bytes.includes(0)) fail(`binary payload found in ${relativePath}`);
  publishableFiles.push(relativePath);
  publishableBytes += (await stat(path)).size;
};

for (const entry of manifest.files ?? []) {
  if (typeof entry !== "string" || !entry || entry.startsWith("/") || !insideRoot(resolve(root, entry))) {
    fail(`invalid package files entry ${String(entry)}`);
  }
  await walkPublishable(resolve(root, entry), entry);
}
const forbiddenPublishable = publishableFiles.filter((path) => forbiddenPath.test(path));
if (forbiddenPublishable.length > 0) {
  fail(`restricted publish payload:\n${forbiddenPublishable.join("\n")}`);
}
if (publishableBytes > 2 * 1024 * 1024) {
  fail(`publish payload is unexpectedly large (${publishableBytes} bytes)`);
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu;
for (const file of publishableFiles.filter((path) => path.endsWith(".js"))) {
  const source = await readFile(resolve(root, file), "utf8");
  const unexpected = [...source.matchAll(importPattern)]
    .map((match) => match[1])
    .filter(
      (specifier) =>
        specifier &&
        !specifier.startsWith(".") &&
        !Object.hasOwn(manifest.dependencies ?? {}, specifier) &&
        specifier !== "@haneoka/altair" &&
        !specifier.startsWith("@haneoka/altair/"),
    );
  if (unexpected.length > 0) {
    fail(`unexpected runtime imports in ${file}: ${unexpected.join(", ")}`);
  }
}

console.log(
  `Verified ${manifest.name}: ${targets.size} exports, ${publishableFiles.length} files, ${publishableBytes} bytes.`,
);
