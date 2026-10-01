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
 * The file is placed in `<ModManagerApp>/mods/jjkmod/<modFolderName>.jjkmod`.
 * If a file already exists it is overwritten.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {{ jjkmodPath: string, zipPath: string }}  Path to the produced .jjkmod file
 *   (`zipPath` is a deprecated alias kept for backwards compatibility).
 */
async function packageSingleMod(modFolderPath) {
  if (!modFolderPath || typeof modFolderPath !== "string") {
    throw new Error("Invalid mod folder path.");
  }

  const stat = await fs.stat(modFolderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${modFolderPath}`);
  }

  const modFolderName = path.basename(modFolderPath);
  // Place the .jjkmod in <ModManagerApp>/mods/jjkmod/
  const outDir = path.join(APP_DIR, "mods", "jjkmod");
  await fs.mkdir(outDir, { recursive: true });
  const jjkmodPath = path.join(outDir, `${modFolderName}.jjkmod`);

  const zip = new AdmZip();

  // Recursively add all files from the mod folder, preserving relative paths.
  await addFolderToZip(zip, modFolderPath, modFolderName);

  zip.writeZip(jjkmodPath);

  return { jjkmodPath, zipPath: jjkmodPath };
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

module.exports = { packageSingleMod };
