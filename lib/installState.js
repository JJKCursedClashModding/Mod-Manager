/**
 * "Are the installed mods up to date?" — compares what the last successful
 * install deployed (recorded in build/deploy-manifest.json, per game target)
 * with the currently enabled mods and their content.
 *
 * Content fingerprint per mod: SHA-1 over every file's relative path, size
 * and mtime (no file contents are read), so it is cheap but catches edits,
 * added/removed files and manifest.json priority changes.
 */
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { yieldToEventLoop } = require("./asyncUtils");

const MAX_FILES = 50000;

/**
 * @param {string} modPath
 * @returns {Promise<string>}  hex SHA-1 fingerprint
 */
async function fingerprintMod(modPath) {
  const lines = [];
  const stack = [""];
  let dirs = 0;
  while (stack.length > 0 && lines.length < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(rel ? path.join(modPath, rel) : modPath, { withFileTypes: true });
    } catch {
      continue;
    }
    if (++dirs % 25 === 0) await yieldToEventLoop();
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(path.join(modPath, childRel));
          lines.push(`${childRel.toLowerCase()}\t${st.size}\t${Math.floor(st.mtimeMs)}`);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  lines.sort();
  return crypto.createHash("sha1").update(lines.join("\n")).digest("hex");
}

/**
 * @param {Array<{id:string, fullPath:string}>} mods  Enabled mods.
 * @returns {Promise<Record<string,string>>}  id → fingerprint
 */
async function fingerprintMods(mods) {
  const out = {};
  for (const mod of mods) {
    out[mod.id] = await fingerprintMod(mod.fullPath);
    await yieldToEventLoop();
  }
  return out;
}

/**
 * Diffs the recorded install against the current enabled mods.
 *
 * @param {Record<string,string>|null|undefined} installed  From the deploy manifest.
 * @param {Record<string,string>} current
 * @returns {Array<{ id:string, kind:"added"|"removed"|"changed" }>}
 */
function diffInstalled(installed, current) {
  const changes = [];
  const before = installed || {};
  for (const id of Object.keys(current)) {
    if (!(id in before)) changes.push({ id, kind: "added" });
    else if (before[id] !== current[id]) changes.push({ id, kind: "changed" });
  }
  for (const id of Object.keys(before)) {
    if (!(id in current)) changes.push({ id, kind: "removed" });
  }
  return changes.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { fingerprintMod, fingerprintMods, diffInstalled };
