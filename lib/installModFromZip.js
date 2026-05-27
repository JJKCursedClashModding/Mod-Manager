const fs = require("fs/promises");
const path = require("path");
const { existsSync, mkdirSync } = require("fs");
const AdmZip = require("adm-zip");

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
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return parseManifestVersion(parsed);
  } catch {
    return null;
  }
}

async function extractZipToModFolder(fileEntries, modFolderPath, stripPrefix) {
  await fs.mkdir(modFolderPath, { recursive: true });

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
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    await fs.writeFile(destPath, entry.getData());
  }

  const remaining = await fs.readdir(modFolderPath);
  if (remaining.length === 0) {
    await fs.rm(modFolderPath, { recursive: true, force: true });
    throw new Error("Zip did not contain any mod files.");
  }
}

/**
 * Installs a mod zip into the mods folder.
 * If the mod folder already exists, compares manifest.json versions and
 * replaces only when the incoming version is newer.
 *
 * @param {string} zipPath
 * @param {string} modsFolder
 * @returns {{ modFolderName: string, modFolderPath: string, action: 'installed'|'updated'|'unchanged', existingVersion?: string, incomingVersion?: string }}
 */
async function installModFromZip(zipPath, modsFolder) {
  if (!zipPath || typeof zipPath !== "string") {
    throw new Error("No zip file selected.");
  }
  if (!modsFolder || typeof modsFolder !== "string") {
    throw new Error("No mods folder available.");
  }
  if (!existsSync(zipPath)) {
    throw new Error(`Zip file not found: ${zipPath}`);
  }

  const zip = new AdmZip(zipPath);
  const fileEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (fileEntries.length === 0) {
    throw new Error("Zip file is empty.");
  }

  const topLevels = new Set();
  for (const entry of fileEntries) {
    const segment = topLevelSegment(entry.entryName);
    if (segment) {
      topLevels.add(segment);
    }
  }

  const zipBaseName = path.basename(zipPath, path.extname(zipPath));
  const hasRootManifest = fileEntries.some((entry) => {
    const normalized = normalizeEntryName(entry.entryName);
    return normalized === "manifest.json";
  });

  let modFolderName;
  let stripPrefix = null;

  if (topLevels.size === 1) {
    modFolderName = [...topLevels][0];
    stripPrefix = `${modFolderName}/`;
  } else if (hasRootManifest) {
    modFolderName = zipBaseName;
    stripPrefix = "";
  } else {
    modFolderName = zipBaseName;
    stripPrefix = "";
  }

  const modFolderPath = path.join(modsFolder, modFolderName);
  const manifestEntry = findManifestEntry(fileEntries, stripPrefix);
  if (!manifestEntry) {
    throw new Error("Zip does not contain a manifest.json for this mod.");
  }

  const incomingVersion = readVersionFromZipManifest(manifestEntry);
  const folderExists = existsSync(modFolderPath);
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

module.exports = { installModFromZip };
