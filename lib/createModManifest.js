const fs = require("fs/promises");
const path = require("path");

/**
 * Creates a default manifest.json inside a mod folder — only if none exists.
 *
 * Never overwrites an existing manifest.json.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {{ created: boolean, manifestPath: string }}  Whether a file was
 *   created and the absolute path to the manifest.
 */
async function createModManifest(modFolderPath) {
  if (!modFolderPath || typeof modFolderPath !== "string") {
    throw new Error("Invalid mod folder path.");
  }

  const stat = await fs.stat(modFolderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${modFolderPath}`);
  }

  const folderName = path.basename(modFolderPath);
  const manifestPath = path.join(modFolderPath, "manifest.json");

  const defaults = {
    title: folderName,
    description: "",
    version: "1.0.0",
    priority: 0,
  };

  try {
    await fs.writeFile(manifestPath, `${JSON.stringify(defaults, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return { created: false, manifestPath };
    }
    throw error;
  }

  return { created: true, manifestPath };
}

module.exports = { createModManifest };
