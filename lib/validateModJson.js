const fs = require("fs/promises");
const path = require("path");
const { yieldToEventLoop } = require("./asyncUtils");

/**
 * Validates every JSON file inside a mod folder.
 *
 * Scans the mod root (`manifest.json`, `AssetRegistry.json`) plus all
 * `*.json` files under `datatables/` and `parameters/` (recursively), and
 * reports files that fail to parse. Shape mismatches that would break
 * packaging are also reported:
 * - `manifest.json` must be a JSON object.
 * - `AssetRegistry.json` must be a JSON array.
 * - files under `datatables/` / `parameters/` must be JSON objects.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {Promise<{ modId: string, modPath: string, checked: string[], errors: Array<{ file: string, message: string }> }>}
 *   `checked` and `file` are paths relative to the mod folder.
 */
async function validateModJson(modFolderPath) {
  if (!modFolderPath || typeof modFolderPath !== "string") {
    throw new Error("Invalid mod folder path.");
  }

  const stat = await fs.stat(modFolderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${modFolderPath}`);
  }

  const modId = path.basename(modFolderPath);
  const files = await collectJsonFiles(modFolderPath);

  const checked = [];
  const errors = [];
  let n = 0;
  for (const abs of files) {
    const rel = path.relative(modFolderPath, abs).split(path.sep).join("/");
    checked.push(rel);
    const problem = await validateJsonFile(abs, rel);
    if (problem) {
      errors.push({ file: rel, message: problem });
    }
    if (++n % 20 === 0) await yieldToEventLoop();
  }
  await yieldToEventLoop();

  return { modId, modPath: modFolderPath, checked, errors };
}

/**
 * Recursively collects absolute paths of all `*.json` files under `root`,
 * skipping symlinks. Symlinked dirs could otherwise escape the mod folder.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function collectJsonFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        found.push(abs);
      }
    }
  }
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

/**
 * Parses a single JSON file and checks its expected shape.
 *
 * @param {string} abs  Absolute file path.
 * @param {string} rel  Mod-relative path (forward slashes) for error context.
 * @returns {Promise<string|null>}  Error description, or null when valid.
 */
async function validateJsonFile(abs, rel) {
  let raw;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (error) {
    return `Could not read file: ${error instanceof Error ? error.message : String(error)}`;
  }

  const text = raw.replace(/^\uFEFF/, ""); // tolerate UTF-8 BOM like the packager does
  if (!text.trim()) {
    return "File is empty — expected a JSON document.";
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const lower = rel.toLowerCase();
  const base = lower.split("/").pop();
  if (base === "manifest.json") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "manifest.json must be a JSON object (e.g. { \"title\": \"…\", \"version\": \"1.0.0\" }).";
    }
  } else if (base === "assetregistry.json") {
    if (!Array.isArray(parsed)) {
      return "AssetRegistry.json must be a JSON array of asset entries.";
    }
  } else if (lower.startsWith("datatables/") || lower.startsWith("parameters/")) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Expected a JSON object of row keys to row values (e.g. { \"RowName\": { … } }).";
    }
  }

  return null;
}

module.exports = { validateModJson };
