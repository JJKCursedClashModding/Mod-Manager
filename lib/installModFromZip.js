const fs = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const { yieldToEventLoop, existsAsync } = require("./asyncUtils");
const { parseJsonText, readJsonFile } = require("./jsonUtils");

/** Characters Windows forbids in file/folder names (plus ASCII controls). */
const INVALID_NAME_CHARS = /[<>:"|?*\x00-\x1F]/;
/** Reserved DOS device names — unusable as a folder name on Windows. */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Checks a single path segment (folder or file name) from a zip entry or
 * zip file name. Rejects anything that could resolve somewhere other than
 * a plain child: `.`/`..`, empty, drive letters / ADS (`:`), other invalid
 * Windows characters, and trailing dots/spaces (Windows strips those, so
 * `...` would collapse onto the parent directory).
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isSafeSegment(segment) {
  if (typeof segment !== "string" || !segment) return false;
  if (segment === "." || segment === "..") return false;
  if (INVALID_NAME_CHARS.test(segment)) return false;
  if (/[. ]$/.test(segment)) return false;
  return true;
}

/** Folder-name check for the mod's folder inside the mods library. */
function isSafeModFolderName(name) {
  return isSafeSegment(name) && !RESERVED_DEVICE_NAME.test(name) && name.trim() === name;
}

/**
 * Normalizes a zip entry name to a relative posix path: backslashes become
 * slashes, leading slashes and empty / `./` segments are dropped.
 * Throws on `..` anywhere or any otherwise unsafe segment — a crafted zip is
 * rejected as a whole rather than partially extracted.
 *
 * @param {string} entryName
 * @returns {string}  Normalized relative path ("" for an entry that is only separators/dots).
 */
function normalizeEntryName(entryName) {
  const segments = String(entryName ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".");
  for (const seg of segments) {
    if (!isSafeSegment(seg)) {
      throw new Error(`Unsafe zip entry path: ${entryName}`);
    }
  }
  return segments.join("/");
}

/**
 * Archive junk that is never part of a mod: macOS resource forks
 * (`__MACOSX/…`) and dotfiles / dot-folders such as `.DS_Store`, `._foo`
 * or `.git/`. Ignored both when picking the mod folder and when extracting.
 *
 * @param {string} relative  Normalized entry path.
 */
function isIgnoredEntryPath(relative) {
  return relative
    .split("/")
    .some((seg) => seg.toLowerCase() === "__macosx" || seg.startsWith("."));
}

/**
 * Normalizes and filters a zip's file entries once, so folder detection,
 * manifest lookup and extraction all agree on the same names.
 *
 * @param {Array} fileEntries  AdmZip file (non-directory) entries.
 * @returns {Array<{ entry: object, rel: string }>}
 */
function prepareEntries(fileEntries) {
  const out = [];
  for (const entry of fileEntries) {
    const rel = normalizeEntryName(entry.entryName);
    if (!rel || isIgnoredEntryPath(rel)) continue;
    out.push({ entry, rel });
  }
  return out;
}

function topLevelSegment(relative) {
  const slash = relative.indexOf("/");
  return slash === -1 ? relative : relative.slice(0, slash);
}

function resolveDestPath(destRoot, relativePath) {
  const dest = path.resolve(destRoot, relativePath);
  const root = path.resolve(destRoot);
  if (dest === root || !dest.startsWith(root + path.sep)) {
    throw new Error(`Unsafe zip entry path: ${relativePath}`);
  }
  return dest;
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Resolves `<modsFolder>/<modFolderName>` and asserts it is a strict, direct
 * child of the mods folder (never the folder itself or anything above it).
 * The update path recursively deletes this directory, so this is the last
 * line of defence against wiping the library.
 */
function resolveModFolderPath(modsFolder, modFolderName) {
  if (!isSafeModFolderName(modFolderName)) {
    throw new Error(`Invalid mod folder name in zip: "${modFolderName}"`);
  }
  const root = path.resolve(modsFolder);
  const modFolderPath = path.resolve(root, modFolderName);
  if (samePath(modFolderPath, root) || !samePath(path.dirname(modFolderPath), root)) {
    throw new Error(`Mod folder "${modFolderName}" resolves outside the mods folder.`);
  }
  return modFolderPath;
}

function parseManifestVersion(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const v = parsed.version;
  if (typeof v === "string" && v.trim()) {
    return v.trim();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return null;
}

function versionLabel(version) {
  return version || "0.0.0";
}

function parseVersion(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

function compareVersions(incoming, existing) {
  const left = parseVersion(versionLabel(incoming));
  const right = parseVersion(versionLabel(existing));
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const av = left[i] ?? 0;
    const bv = right[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function findManifestEntry(prepared, stripPrefix) {
  const target = stripPrefix ? `${stripPrefix}manifest.json` : "manifest.json";
  const found = prepared.find((item) => item.rel === target);
  return found ? found.entry : null;
}

function readManifestFromZipEntry(manifestEntry, label = "zip file") {
  try {
    return parseJsonText(manifestEntry.getData());
  } catch {
    throw new Error(`Could not read manifest.json from the ${label}.`);
  }
}

function readVersionFromZipManifest(manifestEntry) {
  if (!manifestEntry) {
    return null;
  }
  return parseManifestVersion(readManifestFromZipEntry(manifestEntry));
}

async function readVersionFromModFolder(modFolderPath) {
  const manifestPath = path.join(modFolderPath, "manifest.json");
  try {
    return parseManifestVersion(await readJsonFile(manifestPath));
  } catch {
    return null;
  }
}

/**
 * Opens a zip file without blocking the event loop longer than necessary.
 * The AdmZip constructor + entry inflate are synchronous, so we yield
 * before and after the blocking section and let callers yield between
 * entries during extraction.
 */
async function openZipAsync(zipPath) {
  if (!(await existsAsync(zipPath))) {
    throw new Error(`Mod file not found:\n${zipPath}`);
  }
  // Let pending IPC paint before the synchronous parse blocks the loop.
  await yieldToEventLoop();
  const zip = new AdmZip(zipPath);
  const fileEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
  // Normalize + validate every name up front: unsafe names reject the
  // whole archive, junk (__MACOSX/, dotfiles) is dropped.
  const prepared = prepareEntries(fileEntries);
  await yieldToEventLoop();
  return { zip, fileEntries, prepared };
}

async function extractZipToModFolder(prepared, modFolderPath, stripPrefix) {
  await fs.mkdir(modFolderPath, { recursive: true });
  await yieldToEventLoop();

  let written = 0;
  for (const { entry, rel } of prepared) {
    let relative = rel;
    if (stripPrefix) {
      if (!relative.startsWith(stripPrefix)) {
        continue;
      }
      relative = relative.slice(stripPrefix.length);
    }

    if (!relative) {
      continue;
    }

    const destPath = resolveDestPath(modFolderPath, relative);
    const destDir = path.dirname(destPath);
    try {
      await fs.mkdir(destDir, { recursive: true });
    } catch {
      /* exists → ignore */
    }
    // getData() inflates synchronously — yield every few files so the
    // main loop stays responsive for large mods.
    await fs.writeFile(destPath, entry.getData());
    if (++written % 10 === 0) await yieldToEventLoop();
  }
  await yieldToEventLoop();

  const remaining = await fs.readdir(modFolderPath);
  if (remaining.length === 0) {
    await fs.rm(modFolderPath, { recursive: true, force: true });
    throw new Error("Zip did not contain any mod files.");
  }
}

/**
 * Picks the library folder name for a zip:
 * - every (non-junk) entry sits under one top-level folder → that folder;
 * - otherwise (root-level manifest.json or mixed roots) → the zip's base name.
 * The chosen name is validated so it can only ever be a plain child folder.
 */
function resolveModFolderName(prepared, zipPath) {
  const topLevels = new Set();
  let hasRootFile = false;
  for (const { rel } of prepared) {
    if (!rel.includes("/")) {
      hasRootFile = true;
    }
    topLevels.add(topLevelSegment(rel));
  }
  if (topLevels.size === 1 && !hasRootFile) {
    const modFolderName = [...topLevels][0];
    if (!isSafeModFolderName(modFolderName)) {
      throw new Error(`Invalid mod folder name in zip: "${modFolderName}"`);
    }
    return { modFolderName, stripPrefix: `${modFolderName}/` };
  }
  const zipBaseName = path.basename(zipPath, path.extname(zipPath)).trim();
  if (!isSafeModFolderName(zipBaseName)) {
    throw new Error(
      `Cannot use the file name "${zipBaseName}" as a mod folder name. Rename the file and try again.`,
    );
  }
  return { modFolderName: zipBaseName, stripPrefix: "" };
}

/**
 * Peeks into a .jjkmod/.zip without extracting it, returning the mod
 * display name for the "Do you want to install NAME?" prompt.
 * Async — yields around the blocking zip parse so opening a large
 * .jjkmod never freezes the UI.
 *
 * @param {string} zipPath
 * @returns {Promise<{ fileName: string, modFolderName: string, title: string, version: string|null, displayName: string }>}
 */
async function peekModInfo(zipPath) {
  if (!zipPath || typeof zipPath !== "string") {
    throw new Error("No mod file provided.");
  }
  const { prepared } = await openZipAsync(zipPath);
  if (prepared.length === 0) {
    throw new Error("Mod file is empty.");
  }
  const { modFolderName, stripPrefix } = resolveModFolderName(prepared, zipPath);
  const manifestEntry = findManifestEntry(prepared, stripPrefix);
  if (!manifestEntry) {
    throw new Error("Mod file does not contain a manifest.json for this mod.");
  }
  // Only the small manifest entry is inflated here — not the whole mod.
  const parsed = readManifestFromZipEntry(manifestEntry, "mod file");
  await yieldToEventLoop();
  const title =
    parsed && typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : modFolderName;
  const version = parseManifestVersion(parsed);
  return {
    fileName: path.basename(zipPath),
    modFolderName,
    title,
    version,
    displayName: title || modFolderName,
  };
}

/**
 * Installs a mod zip into the mods folder.
 * Async with per-file yields — large archives install without hanging main.
 *
 * Version rules when the mod folder already exists:
 * - newer incoming version → replaced ("updated");
 * - same version → replaced only when `options.allowReinstall` is set
 *   (the renderer asks the user first), else "unchanged" with reason "same";
 * - older incoming version → never replaced ("unchanged", reason "older").
 *
 * @param {string} zipPath
 * @param {string} modsFolder
 * @param {{ allowReinstall?: boolean }} [options]
 * @returns {Promise<{ modFolderName: string, modFolderPath: string, action: 'installed'|'updated'|'reinstalled'|'unchanged', reason?: 'same'|'older', zipPath: string, existingVersion?: string, incomingVersion?: string }>}
 */
async function installModFromZip(zipPath, modsFolder, options = {}) {
  if (!zipPath || typeof zipPath !== "string") {
    throw new Error("No zip file selected.");
  }
  if (!modsFolder || typeof modsFolder !== "string") {
    throw new Error("No mods folder available.");
  }

  const { prepared } = await openZipAsync(zipPath);
  if (prepared.length === 0) {
    throw new Error("Zip file is empty.");
  }

  const { modFolderName, stripPrefix } = resolveModFolderName(prepared, zipPath);
  const modFolderPath = resolveModFolderPath(modsFolder, modFolderName);
  const manifestEntry = findManifestEntry(prepared, stripPrefix);
  if (!manifestEntry) {
    throw new Error("Zip does not contain a manifest.json for this mod.");
  }

  const incomingVersion = readVersionFromZipManifest(manifestEntry);
  await yieldToEventLoop();
  const folderExists = await existsAsync(modFolderPath);
  let existingVersion = null;
  let cmp = 1;

  if (folderExists) {
    existingVersion = await readVersionFromModFolder(modFolderPath);
    cmp = compareVersions(incomingVersion, existingVersion);
    if (cmp < 0 || (cmp === 0 && !options.allowReinstall)) {
      return {
        modFolderName,
        modFolderPath,
        action: "unchanged",
        reason: cmp < 0 ? "older" : "same",
        zipPath,
        existingVersion: versionLabel(existingVersion),
        incomingVersion: versionLabel(incomingVersion),
      };
    }
    await fs.rm(modFolderPath, { recursive: true, force: true });
    await yieldToEventLoop();
  }

  await extractZipToModFolder(prepared, modFolderPath, stripPrefix);

  let action = "installed";
  if (folderExists) {
    action = cmp === 0 ? "reinstalled" : "updated";
  }
  return {
    modFolderName,
    modFolderPath,
    action,
    zipPath,
    existingVersion: folderExists ? versionLabel(existingVersion) : undefined,
    incomingVersion: versionLabel(incomingVersion),
  };
}

module.exports = {
  installModFromZip,
  peekModInfo,
  compareVersions,
  versionLabel,
  readVersionFromModFolder,
  // Exported for tests.
  normalizeEntryName,
  isIgnoredEntryPath,
  resolveModFolderName,
  resolveModFolderPath,
  prepareEntries,
};
