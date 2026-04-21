const fs = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const { APP_DIR } = require("./constants");

/**
 * Packages a single mod folder into a .zip file.
 *
 * The zip is placed in `<ModManagerApp>/mods/zip/<modFolderName>.zip`.
 * If a zip already exists it is overwritten.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {{ zipPath: string }}  Path to the produced zip file.
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
  // Place the zip in <ModManagerApp>/mods/zip/
  const zipDir = path.join(APP_DIR, "mods", "zip");
  await fs.mkdir(zipDir, { recursive: true });
  const zipPath = path.join(zipDir, `${modFolderName}.zip`);

  const zip = new AdmZip();

  // Recursively add all files from the mod folder, preserving relative paths.
  await addFolderToZip(zip, modFolderPath, modFolderName);

  zip.writeZip(zipPath);

  return { zipPath };
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
