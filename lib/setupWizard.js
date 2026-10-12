const fs = require("fs/promises");
const path = require("path");
const { yieldToEventLoop } = require("./asyncUtils");

/**
 * Legacy files from older manual modding guides.
 *
 * - UE4SS: `dwmapi.dll` + `ue4ss/` next to the game exe
 *   (Binaries/Win64). Only needed to develop UE4SS Lua mods.
 * - DataTablePatcher: old UE4SS Lua mod that patched tables live at
 *   runtime, installed as `ue4ss/Mods/DataTablePatcher/`
 *   (a stray top-level `DataTablePatcher/` next to the exe from very old
 *   manual installs is covered too).
 *
 * The current manager needs neither — it merges tables and builds IoStore
 * packages itself. Players should delete both; modders may keep UE4SS.
 */
const LEGACY_ITEMS = [
  {
    id: "ue4ss",
    name: "UE4SS",
    description:
      "Scripting framework (dwmapi.dll + ue4ss folder). Only keep this if you develop UE4SS Lua mods.",
    relPaths: ["dwmapi.dll", "ue4ss"],
  },
  {
    id: "datatablepatcher",
    name: "DataTablePatcher",
    description:
      "Old UE4SS Lua mod that patched data tables live at runtime. Replaced by this manager's built-in packaging.",
    relPaths: [path.join("ue4ss", "Mods", "DataTablePatcher"), "DataTablePatcher"],
  },
];

function toDisplayRel(rel) {
  return String(rel).split(path.sep).join("/");
}

/**
 * Describes which legacy files exist next to the game exe.
 * Pure existence check — never touches anything.
 *
 * @param {string|null} gameExePath
 * @returns {{ available: boolean, exeDir: string|null, items: Array }}
 */
async function statKind(abs) {
  try {
    const stat = await fs.stat(abs);
    return stat.isDirectory() ? "folder" : "file";
  } catch {
    return null;
  }
}

/**
 * Describes which legacy files exist next to the game exe.
 * Async (non-blocking) — yields between probes so the UI never hangs.
 *
 * @param {string|null} gameExePath
 * @returns {Promise<{ available: boolean, exeDir: string|null, items: Array }>}
 */
async function describeLegacySetup(gameExePath) {
  const exeDir = gameExePath && typeof gameExePath === "string" ? path.dirname(gameExePath) : null;
  const items = [];
  for (const item of LEGACY_ITEMS) {
    const paths = [];
    for (const rel of item.relPaths) {
      const abs = exeDir ? path.join(exeDir, rel) : null;
      let kind = null;
      if (abs) kind = await statKind(abs);
      paths.push({ rel: toDisplayRel(rel), abs, exists: kind !== null, kind });
    }
    items.push({
      id: item.id,
      name: item.name,
      description: item.description,
      found: paths.some((p) => p.exists),
      paths,
    });
    await yieldToEventLoop();
  }
  return { available: Boolean(exeDir), exeDir, items };
}

/**
 * Deletes the selected legacy items. Only the exact known paths under the
 * game exe directory are removed; missing paths are skipped silently.
 *
 * @param {string} gameExePath
 * @param {string[]} targetIds  Subset of ["ue4ss", "datatablepatcher"].
 * @returns {Promise<{ removed: string[], errors: string[] }>}
 */
async function deleteLegacySetupItems(gameExePath, targetIds) {
  if (!gameExePath || typeof gameExePath !== "string") {
    throw new Error("No game executable configured.");
  }
  const exeDir = path.dirname(gameExePath);
  const wanted = new Set(Array.isArray(targetIds) ? targetIds : []);
  const removed = [];
  const errors = [];
  let touched = 0;
  for (const item of LEGACY_ITEMS) {
    if (!wanted.has(item.id)) continue;
    for (const rel of item.relPaths) {
      if (++touched % 4 === 0) await yieldToEventLoop();
      const abs = path.join(exeDir, rel);
      let existed = false;
      try {
        await fs.stat(abs);
        existed = true;
      } catch {
        existed = false;
      }
      if (!existed) continue;
      try {
        await fs.rm(abs, { recursive: true, force: true });
        removed.push(toDisplayRel(rel));
      } catch (error) {
        errors.push(`${toDisplayRel(rel)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { removed, errors };
}

module.exports = { LEGACY_ITEMS, describeLegacySetup, deleteLegacySetupItems };
