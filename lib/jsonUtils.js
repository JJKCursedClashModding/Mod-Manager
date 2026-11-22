const fs = require("fs/promises");

/**
 * Shared JSON helpers for files that come from mods (manifest.json,
 * AssetRegistry.json, datatables/, parameters/).
 *
 * Mod authors often save JSON from Notepad/VS on Windows with a UTF-8 BOM
 * (U+FEFF), which `JSON.parse` rejects. Every reader of mod JSON goes
 * through these so a BOM never breaks one code path but not another.
 */

/** Strips a leading UTF-8 BOM from decoded text. */
function stripBom(text) {
  const s = String(text ?? "");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Parses JSON text (string or Buffer), tolerating a UTF-8 BOM.
 * Throws the native SyntaxError on invalid JSON.
 *
 * @param {string|Buffer} input
 * @returns {any}
 */
function parseJsonText(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  return JSON.parse(stripBom(text));
}

/**
 * Reads and parses a JSON file, tolerating a UTF-8 BOM.
 * Throws on read errors and invalid JSON (callers decide how to recover).
 *
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readJsonFile(filePath) {
  return parseJsonText(await fs.readFile(filePath, "utf8"));
}

/**
 * Reads `manifest.json` `priority` the one way the whole app uses it.
 * Finite numbers are used as-is; numeric strings ("10", " -5 ") are coerced
 * (authors often quote numbers); anything else falls back to 0.
 * `problem` describes a non-number value so the validator can flag it.
 *
 * @param {any} raw  The manifest's `priority` value.
 * @returns {{ value: number, problem: string|null }}
 */
function parseManifestPriority(raw) {
  if (raw === undefined || raw === null) {
    return { value: 0, problem: null };
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { value: raw, problem: null }
      : { value: 0, problem: "priority must be a finite number; using 0." };
  }
  if (typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw)) {
    const value = Number(raw.trim());
    return { value, problem: `priority is a string ("${raw}"); it is read as ${value}, but should be a number.` };
  }
  return { value: 0, problem: `priority ${JSON.stringify(raw)} is not a number; using 0.` };
}

module.exports = { stripBom, parseJsonText, readJsonFile, parseManifestPriority };
