const fs = require("fs/promises");
const path = require("path");
const { yieldToEventLoop } = require("./asyncUtils");
const { parseJsonText, parseManifestPriority } = require("./jsonUtils");

/**
 * Validates every JSON file inside a mod folder.
 *
 * Scans the mod root (`manifest.json`, `AssetRegistry.json`) plus all
 * `*.json` files under `datatables/` and `parameters/` (recursively), and
 * reports files that fail to parse. Shape mismatches that would break
 * packaging are also reported, mirroring how the pipeline consumes them:
 * - `manifest.json` must be a JSON object; a non-number `priority` is a
 *   warning (numeric strings are coerced exactly like the mod list/build do).
 * - `AssetRegistry.json` must be a JSON array. Entries the build registers
 *   (those with an `objectName`) need `packageName`, `objectName` and a full
 *   `classPath` such as "/Script/Engine.Texture2D" — the AssetRegistryPatcher
 *   fails the whole build otherwise.
 * - files under `datatables/` / `parameters/` must be JSON objects. The
 *   packager only reads the top level of those folders, so nested files are
 *   flagged as ignored.
 *
 * @param {string} modFolderPath  Absolute path to the mod folder.
 * @returns {Promise<{ modId: string, modPath: string, checked: string[], errors: Array<{ file: string, message: string }>, warnings: Array<{ file: string, message: string }> }>}
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
  const warnings = [];
  let n = 0;
  for (const abs of files) {
    const rel = path.relative(modFolderPath, abs).split(path.sep).join("/");
    checked.push(rel);
    const { error, warning } = await validateJsonFile(abs, rel);
    if (error) {
      errors.push({ file: rel, message: error });
    } else if (warning) {
      warnings.push({ file: rel, message: warning });
    }
    if (++n % 20 === 0) await yieldToEventLoop();
  }
  await yieldToEventLoop();

  return { modId, modPath: modFolderPath, checked, errors, warnings };
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

/** Full top-level class path, e.g. "/Script/Engine.Texture2D" (one "."). */
const FULL_CLASS_PATH = /^\/[^.\s]+\.[^.\s]+$/;
const MAX_LISTED_ENTRIES = 5;

/**
 * Checks AssetRegistry.json entries the way combineAssetRegistries and the
 * AssetRegistryPatcher consume them. Entries without an `objectName` string
 * are skipped by the build, so they are not checked here either.
 * Problems are grouped into one message for the file.
 *
 * @param {Array} entries
 * @returns {string|null}
 */
function validateRegistryEntries(entries) {
  const problems = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`entry ${index}: must be an object`);
      return;
    }
    if (typeof entry.objectName !== "string" || !entry.objectName) {
      return; // not registered by the build
    }
    const missing = [];
    if (typeof entry.packageName !== "string" || !entry.packageName) missing.push("packageName");
    const classPath = typeof entry.classPath === "string" ? entry.classPath.trim() : "";
    if (!classPath) missing.push("classPath");
    if (missing.length > 0) {
      problems.push(`entry ${index} (${entry.objectName}): missing ${missing.join(", ")}`);
    } else if (!FULL_CLASS_PATH.test(classPath)) {
      problems.push(
        `entry ${index} (${entry.objectName}): classPath ${JSON.stringify(entry.classPath)} must be a full class path like "/Script/Engine.Texture2D"`,
      );
    }
  });
  if (problems.length === 0) {
    return null;
  }
  const listed = problems.slice(0, MAX_LISTED_ENTRIES).join("; ");
  const more = problems.length > MAX_LISTED_ENTRIES ? `; …and ${problems.length - MAX_LISTED_ENTRIES} more` : "";
  return (
    `${problems.length} AssetRegistry entr${problems.length === 1 ? "y is" : "ies are"} invalid and would fail the build ` +
    `(packageName, objectName and a full classPath are required): ${listed}${more}`
  );
}

/**
 * Parses a single JSON file and checks its expected shape.
 *
 * @param {string} abs  Absolute file path.
 * @param {string} rel  Mod-relative path (forward slashes) for error context.
 * @returns {Promise<{ error: string|null, warning: string|null }>}
 */
async function validateJsonFile(abs, rel) {
  let raw;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (error) {
    return { error: `Could not read file: ${error instanceof Error ? error.message : String(error)}`, warning: null };
  }

  if (!raw.replace(/^﻿/, "").trim()) {
    return { error: "File is empty — expected a JSON document.", warning: null };
  }

  let parsed;
  try {
    parsed = parseJsonText(raw); // tolerates a UTF-8 BOM like the packager does
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), warning: null };
  }

  const lower = rel.toLowerCase();
  const base = lower.split("/").pop();
  if (lower === "manifest.json") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "manifest.json must be a JSON object (e.g. { \"title\": \"…\", \"version\": \"1.0.0\" }).",
        warning: null,
      };
    }
    return { error: null, warning: parseManifestPriority(parsed.priority).problem };
  }
  if (base === "manifest.json") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "manifest.json must be a JSON object (e.g. { \"title\": \"…\", \"version\": \"1.0.0\" }).",
        warning: null,
      };
    }
  } else if (base === "assetregistry.json") {
    if (!Array.isArray(parsed)) {
      return { error: "AssetRegistry.json must be a JSON array of asset entries.", warning: null };
    }
    if (lower === "assetregistry.json") {
      return { error: validateRegistryEntries(parsed), warning: null };
    }
  } else if (lower.startsWith("datatables/") || lower.startsWith("parameters/")) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Expected a JSON object of row keys to row values (e.g. { \"RowName\": { … } }).",
        warning: null,
      };
    }
    const folder = lower.split("/")[0];
    if (lower.split("/").length > 2) {
      return {
        error: null,
        warning: `Ignored by the build: only files directly inside ${folder}/ are read. Move it to ${folder}/${rel.split("/").pop()}.`,
      };
    }
  }

  return { error: null, warning: null };
}

module.exports = { validateModJson };
