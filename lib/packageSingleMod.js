const fs = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const { APP_DIR } = require("./constants");

/**
 * Packages a single mod folder into a .jjkmod file.
 *
 * A .jjkmod file is a zip with a .jjkmod extension, containing the mod
 * folder as a single top-level directory (which the installer accepts).
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @param {string} outPath  Absolute path to write the .jjkmod file to
 *   (chosen by the user via the save dialog; the `.jjkmod` extension is
 *   appended when missing). When omitted, falls back to
 *   `<ModManagerApp>/mods/jjkmod/<title> <version>.jjkmod` (title/version
 *   from the mod's `manifest.json`, folder name when unavailable).
 *   An existing file at the destination is overwritten.
 * @returns {{ jjkmodPath: string, zipPath: string }}  Path to the produced .jjkmod file
 *   (`zipPath` is a deprecated alias kept for backwards compatibility).
 */
async function packageSingleMod(modFolderPath, outPath) {
  if (!modFolderPath || typeof modFolderPath !== "string") {
    throw new Error("Invalid mod folder path.");
  }

  const stat = await fs.stat(modFolderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${modFolderPath}`);
  }

  const modFolderName = path.basename(modFolderPath);
  let jjkmodPath;
  if (outPath && typeof outPath === "string" && outPath.trim()) {
    jjkmodPath = outPath.trim();
    if (path.extname(jjkmodPath).toLowerCase() !== ".jjkmod") {
      jjkmodPath += ".jjkmod";
    }
  } else {
    // Fallback when no save location was given.
    const outDir = path.join(APP_DIR, "mods", "jjkmod");
    await fs.mkdir(outDir, { recursive: true });
    jjkmodPath = path.join(outDir, await defaultJjkmodFileName(modFolderPath));
  }
  await fs.mkdir(path.dirname(jjkmodPath), { recursive: true });

  const zip = new AdmZip();

  // Recursively add all files from the mod folder, preserving relative paths.
  await addFolderToZip(zip, modFolderPath, modFolderName);

  zip.writeZip(jjkmodPath);

  return { jjkmodPath, zipPath: jjkmodPath };
}

/**
 * Returns the suggested initial save path for the save dialog
 * (`<ModManagerApp>/mods/jjkmod/<title> <version>.jjkmod`), creating the
 * parent folder so the dialog opens in a valid location.
 *
 * The file name defaults to the mod's `manifest.json` title plus version
 * (e.g. `My Cool Mod 1.2.0.jjkmod`), falling back to the folder name when
 * the manifest or version is missing. Unsafe filename characters are replaced.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @param {string} [preferredDir]  Last-used export folder; defaults to `<ModManagerApp>/mods/jjkmod`.
 * @returns {Promise<string>}  Suggested absolute `.jjkmod` path.
 */
async function suggestedJjkmodPath(modFolderPath, preferredDir) {
  let outDir = path.join(APP_DIR, "mods", "jjkmod");
  if (preferredDir && typeof preferredDir === "string" && preferredDir.trim()) {
    outDir = preferredDir.trim();
  }
  await fs.mkdir(outDir, { recursive: true });
  return path.join(outDir, await defaultJjkmodFileName(modFolderPath));
}

/**
 * Replaces Windows-unsafe filename characters so a manifest `title` /
 * `version` can be used as the default export file name.
 *
 * @param {string} name  Raw base name (without extension).
 * @returns {string}  Sanitized base name (may be empty when nothing usable remains).
 */
function sanitizeExportBaseName(name) {
  if (!name || typeof name !== "string") return "";
  let s = name.replace(/[<>:\"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").trim();
  // Windows ignores/trailing-strips dots and spaces — remove them.
  s = s.replace(/[. ]+$/g, "").trim();
  if (s.length > 150) {
    s = s.slice(0, 150).trim().replace(/[. ]+$/g, "");
  }
  return s;
}

/**
 * Reads `manifest.json` for the export file name (best-effort — falls back
 * to the folder name when the manifest is missing/unparseable).
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @param {string} fallbackName  Folder name to use when the manifest has no title.
 * @returns {Promise<{ title: string, version: string|undefined }>}
 */
async function readTitleAndVersion(modFolderPath, fallbackName) {
  try {
    const raw = await fs.readFile(path.join(modFolderPath, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    let title = fallbackName;
    if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
      title = parsed.title.trim();
    }
    let version;
    const v = parsed ? parsed.version : undefined;
    if (typeof v === "string" && v.trim()) {
      version = v.trim();
    } else if (typeof v === "number" && Number.isFinite(v)) {
      version = String(v);
    }
    return { title, version };
  } catch {
    return { title: fallbackName, version: undefined };
  }
}

/**
 * Builds the default `.jjkmod` file name (`<title> <version>.jjkmod`, or
 * just `<title>.jjkmod` when the manifest has no version).
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {Promise<string>}  File name including the `.jjkmod` extension.
 */
async function defaultJjkmodFileName(modFolderPath) {
  const fallbackName = path.basename(modFolderPath) || "mod";
  const { title, version } = await readTitleAndVersion(modFolderPath, fallbackName);
  let base = title;
  if (version) {
    // Don't duplicate the version when the title already ends with it
    // (e.g. title "My Mod v1.2.0" + version "1.2.0" → just the title).
    const lowerTitle = title.toLowerCase();
    const lowerVer = version.toLowerCase();
    const alreadyTagged =
      lowerTitle === lowerVer ||
      lowerTitle.endsWith(` ${lowerVer}`) ||
      lowerTitle.endsWith(`v${lowerVer}`) ||
      lowerTitle.endsWith(`-${lowerVer}`) ||
      lowerTitle.endsWith(`_${lowerVer}`);
    if (!alreadyTagged) {
      base = `${title} ${version}`;
    }
  }
  const safe = sanitizeExportBaseName(base) || sanitizeExportBaseName(fallbackName) || "mod";
  return `${safe}.jjkmod`;
}

/**
 * Recursively adds all files in `folderPath` to `zip` under `zipPrefix`.
 *
 * @param {AdmZip} zip
 * @param {string} folderPath  Absolute path to the folder to add.
 * @param {string} zipPrefix   Path prefix inside the zip (e.g. "MyMod").
 */
async function addFolderToZip(zip, folderPath, zipPrefix) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(folderPath, entry.name);
    const entryZipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      await addFolderToZip(zip, entryPath, entryZipPath);
    } else if (entry.isFile()) {
      const data = await fs.readFile(entryPath);
      // addFile(entryName, data, comment, attr)
      // entryName must use forward slashes for zip compatibility
      zip.addFile(entryZipPath.replace(/\\/g, "/"), data);
    }
  }
}

module.exports = { packageSingleMod, suggestedJjkmodPath, defaultJjkmodFileName };
