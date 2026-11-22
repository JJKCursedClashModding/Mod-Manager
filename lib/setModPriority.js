const fs = require("fs/promises");
const path = require("path");
const { stripBom } = require("./jsonUtils");

/** Largest priority accepted from the UI (keeps values exact and sane). */
const MAX_ABS_PRIORITY = 1_000_000_000;

function validatePriority(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > MAX_ABS_PRIORITY) {
    throw new Error(`Priority must be a whole number between -${MAX_ABS_PRIORITY} and ${MAX_ABS_PRIORITY}.`);
  }
  return value;
}

function withoutPriority(obj) {
  const copy = { ...obj };
  delete copy.priority;
  return JSON.stringify(copy);
}

/**
 * Returns manifest.json text with its top-level `priority` set, keeping the
 * rest of the file byte-for-byte when possible: an existing single
 * `"priority": <number|string>` is edited in place. Otherwise (no priority
 * yet, or ambiguous text) the object is re-serialized with the file's
 * detected indent, line endings, BOM and trailing newline.
 *
 * @param {string} text      Current manifest.json text.
 * @param {number} priority  Integer priority.
 * @returns {string}
 */
function setPriorityInManifestText(text, priority) {
  validatePriority(priority);
  const raw = String(text ?? "");
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = stripBom(raw);
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("manifest.json must be a JSON object.");
  }

  const re = /("priority"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")/g;
  // Edit in place: try each `"priority": …` occurrence and keep the one that
  // changes only the top-level value (nested "priority" keys stay untouched).
  if (Object.prototype.hasOwnProperty.call(parsed, "priority")) {
    for (const m of body.matchAll(re)) {
      const next = body.slice(0, m.index) + m[1] + String(priority) + body.slice(m.index + m[0].length);
      try {
        const check = JSON.parse(next);
        if (check.priority === priority && withoutPriority(check) === withoutPriority(parsed)) {
          return (hasBom ? "﻿" : "") + next;
        }
      } catch {
        /* try the next occurrence */
      }
    }
  }

  const indentMatch = body.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : 2;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify({ ...parsed, priority }, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(body) || !body.trim()) out += eol;
  return (hasBom ? "﻿" : "") + out;
}

/**
 * Writes `priority` into `<modPath>/manifest.json` (atomic temp + rename).
 * Creates a minimal manifest when the mod has none.
 */
async function setModPriority(modPath, priority) {
  validatePriority(priority);
  const manifestPath = path.join(modPath, "manifest.json");
  let text;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    text = `${JSON.stringify({ title: path.basename(modPath), description: "", version: "1.0.0" }, null, 2)}\n`;
  }
  let next;
  try {
    next = setPriorityInManifestText(text, priority);
  } catch (error) {
    throw new Error(`Could not update manifest.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, manifestPath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return { manifestPath, priority };
}

module.exports = { setModPriority, setPriorityInManifestText, validatePriority };
