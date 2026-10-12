const fs = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const { yieldToEventLoop, existsAsync } = require("./asyncUtils");

function normalizeEntryName(entryName) {
  return entryName.replace(/\\/g, "/").replace(/^\/+/, "");
}

function topLevelSegment(entryName) {
  const normalized = normalizeEntryName(entryName);
  const slash = normalized.indexOf("/");
  if (slash === -1) {
    return normalized;
  }
  return normalized.slice(0, slash);
}

function resolveDestPath(destRoot, relativePath) {
  const dest = path.resolve(destRoot, relativePath);
  const root = path.resolve(destRoot);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error(`Unsafe zip entry path: ${relativePath}`);
  }
  return dest;
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

function findManifestEntry(fileEntries, stripPrefix) {
  const target = stripPrefix ? `${stripPrefix}manifest.json` : "manifest.json";
  return fileEntries.find((entry) => normalizeEntryName(entry.entryName) === target);
}

function readVersionFromZipManifest(manifestEntry) {
  if (!manifestEntry) {
    return null;
  }
  try {
    const parsed = JSON.parse(manifestEntry.getData().toString("utf8"));
    return parseManifestVersion(parsed);
  } catch {
    throw new Error("Could not read manifest.json from the zip file.");
  }
}

async function readVersionFromModFolder(modFolderPath) {
  const manifestPath = path.join(modFolderPath, "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return parseManifestVersion(parsed);
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
  await yieldToEventLoop();
  return { zip, fileEntries };
}

async function extractZipToModFolder(fileEntries, modFolderPath, stripPrefix) {
  await fs.mkdir(modFolderPath, { recursive: true });
  await yieldToEventLoop();

  let written = 0;
  for (const entry of fileEntries) {
    let relative = normalizeEntryName(entry.entryName);
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

function resolveModFolderName(fileEntries, zipPath) {
  const topLevels = new Set();
  for (const entry of fileEntries) {
    const segment = topLevelSegment(entry.entryName);
    if (segment) {
      topLevels.add(segment);
    }
  }
  const zipBaseName = path.basename(zipPath, path.extname(zipPath));
  const hasRootManifest = fileEntries.some(
    (entry) => normalizeEntryName(entry.entryName) === "manifest.json",
  );
  if (topLevels.size === 1) {
    const modFolderName = [...topLevels][0];
    return { modFolderName, stripPrefix: `${modFolderName}/` };
  }
  if (hasRootManifest) {
    return { modFolderName: zipBaseName, stripPrefix: "" };
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
  const { fileEntries } = await openZipAsync(zipPath);
  if (fileEntries.length === 0) {
    throw new Error("Mod file is empty.");
  }
  const { modFolderName, stripPrefix } = resolveModFolderName(fileEntries, zipPath);
  const manifestEntry = findManifestEntry(fileEntries, stripPrefix);
  if (!manifestEntry) {
    throw new Error("Mod file does not contain a manifest.json for this mod.");
  }
  let parsed;
  try {
    // Only the small manifest entry is inflated here — not the whole mod.
    parsed = JSON.parse(manifestEntry.getData().toString("utf8"));
  } catch {
    throw new Error("Could not read manifest.json from the mod file.");
  }
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
 * @param {string} zipPath
 * @param {string} modsFolder
 * @returns {Promise<{ modFolderName: string, modFolderPath: string, action: 'installed'|'updated'|'unchanged', existingVersion?: string, incomingVersion?: string }>}
 */
async function installModFromZip(zipPath, modsFolder) {
  if (!zipPath || typeof zipPath !== "string") {
    throw new Error("No zip file selected.");
  }
  if (!modsFolder || typeof modsFolder !== "string") {
    throw new Error("No mods folder available.");
  }

  const { fileEntries } = await openZipAsync(zipPath);
  if (fileEntries.length === 0) {
    throw new Error("Zip file is empty.");
  }

  const { modFolderName, stripPrefix } = resolveModFolderName(fileEntries, zipPath);
  const modFolderPath = path.join(modsFolder, modFolderName);
  const manifestEntry = findManifestEntry(fileEntries, stripPrefix);
  if (!manifestEntry) {
    throw new Error("Zip does not contain a manifest.json for this mod.");
  }

  const incomingVersion = readVersionFromZipManifest(manifestEntry);
  await yieldToEventLoop();
  const folderExists = await existsAsync(modFolderPath);
  let existingVersion = null;

  if (folderExists) {
    existingVersion = await readVersionFromModFolder(modFolderPath);
    const cmp = compareVersions(incomingVersion, existingVersion);
    if (cmp <= 0) {
      return {
        modFolderName,
        modFolderPath,
        action: "unchanged",
        existingVersion: versionLabel(existingVersion),
        incomingVersion: versionLabel(incomingVersion),
      };
    }
    await fs.rm(modFolderPath, { recursive: true, force: true });
    await yieldToEventLoop();
  }

  await extractZipToModFolder(fileEntries, modFolderPath, stripPrefix);

  return {
    modFolderName,
    modFolderPath,
    action: folderExists ? "updated" : "installed",
    existingVersion: folderExists ? versionLabel(existingVersion) : undefined,
    incomingVersion: versionLabel(incomingVersion),
  };
}

module.exports = { installModFromZip, peekModInfo, compareVersions, versionLabel, readVersionFromModFolder };
