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
 *   `<ModManagerApp>/mods/jjkmod/<modFolderName>.jjkmod`.
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
    jjkmodPath = path.join(outDir, `${modFolderName}.jjkmod`);
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
 * (`<ModManagerApp>/mods/jjkmod/<modFolderName>.jjkmod`), creating the
 * parent folder so the dialog opens in a valid location.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {Promise<string>}  Suggested absolute `.jjkmod` path.
 */
async function suggestedJjkmodPath(modFolderPath) {
  const modFolderName = path.basename(modFolderPath);
  const outDir = path.join(APP_DIR, "mods", "jjkmod");
  await fs.mkdir(outDir, { recursive: true });
  return path.join(outDir, `${modFolderName}.jjkmod`);
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

module.exports = { packageSingleMod, suggestedJjkmodPath };
