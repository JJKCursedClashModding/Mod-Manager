/**
 * Overlap / conflict detection for enabled mods.
 *
 * Checks the same inputs the packaging pipeline merges (see packageAllMods.js):
 *   - datatables/*.json  → same table + same row key (higher priority wins)
 *   - parameters/*.json  → same short name + same row key (higher priority wins)
 *   - assets/**           → same relative path (higher priority overwrites)
 *   - pak_assets/**       → same relative path (higher priority overwrites)
 *   - scripts/**          → same relative path in game scripts/ (higher priority overwrites)
 *   - AssetRegistry.json  → same objectName (higher priority wins)
 *   - prebuilt *.pak/*.utoc/*.ucas in mod root → same file name in ~mods
 *
 * Performance notes:
 *   - Only ENABLED mods are scanned (disabled mods never reach the pipeline).
 *   - One directory walk per mod for assets/pak_assets/scripts (paths only, no hashing).
 *   - Datatable JSONs contribute only their top-level keys, not values.
 *   - Per-mod scan results are cached in-memory; toggling mods on/off
 *     recomputes overlaps from cache with zero FS I/O. Pass rescan=true on
 *     refresh / install / folder-change to re-read from disk.
 *   - The full overlap list is always returned (no cap) so the modal can
 *     show ALL overlaps, including asset overlaps.
 */
const fs = require("fs/promises");
const path = require("path");
const { existsSync } = require("fs");

const MAX_CONFLICTS_RETURNED = 400;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_WALK = 20000;

const PAK_EXTS = new Set([".pak", ".utoc", ".ucas"]);

/** In-memory per-mod scan cache: fullPath → scan result. */
const scanCache = new Map();

function normKey(p) {
  const posix = String(p).replace(/\\/g, "/");
  return process.platform === "win32" ? posix.toLowerCase() : posix;
}

/**
 * Recursively lists all FILES under `root` as posix-style paths relative to
 * `root`. Iterative (no recursion depth risk), skips symlinks, caps count.
 */
async function walkFilesRelative(root, warnings, label) {
  const out = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_WALK) {
        warnings.push(`${label}: stopped after ${MAX_FILES_PER_WALK} files (capped)`);
        return { files: out, truncated: true };
      }
      // Skip symlinks entirely to avoid cycles/escapes.
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  return { files: out, truncated: false };
}

async function readJsonKeys(filePath, warnings, label) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, opaque: true };
  }
  if (stat.size > MAX_JSON_BYTES) {
    warnings.push(`${label}: skipped, file too large (${Math.round(stat.size / 1024 / 1024)} MB)`);
    return { ok: false, opaque: true };
  }
  let parsed;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    warnings.push(`${label}: skipped, invalid JSON`);
    return { ok: false, opaque: true };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { ok: true, opaque: false, keys: Object.keys(parsed) };
  }
  // Non-object JSON (array/scalar) merges opaquely → treat whole file as one unit.
  return { ok: true, opaque: true, keys: [] };
}

/** Scans a single mod folder. Result is cached by the caller. */
async function scanMod(modPath) {
  const warnings = [];
  const assets = [];
  const pakAssets = [];
  const scripts = [];
  const tables = {}; // lower table name → { name, keys: string[], opaque: bool }
  const parameters = {}; // lower short name → { name, keys: string[] }
  const registry = [];
  const prebuilt = [];

  // assets/** (paths only)
  try {
    const stat = await fs.stat(path.join(modPath, "assets"));
    if (stat.isDirectory()) {
      const { files } = await walkFilesRelative(path.join(modPath, "assets"), warnings, "assets");
      for (const f of files) assets.push(f);
    }
  } catch { /* no assets dir */ }

  // pak_assets/** (paths only)
  try {
    const stat = await fs.stat(path.join(modPath, "pak_assets"));
    if (stat.isDirectory()) {
      const { files } = await walkFilesRelative(path.join(modPath, "pak_assets"), warnings, "pak_assets");
      for (const f of files) pakAssets.push(f);
    }
  } catch { /* no pak_assets dir */ }

  // scripts/** (paths only, deployed to game scripts/ for Ultimate ASI Loader)
  try {
    const stat = await fs.stat(path.join(modPath, "scripts"));
    if (stat.isDirectory()) {
      const { files } = await walkFilesRelative(path.join(modPath, "scripts"), warnings, "scripts");
      for (const f of files) scripts.push(f);
    }
  } catch { /* no scripts dir */ }

  // datatables/*.json — top level only (mirrors collectDatatableJsonFiles).
  try {
    const dir = path.join(modPath, "datatables");
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        const tableName = path.parse(entry.name).name;
        const res = await readJsonKeys(path.join(dir, entry.name), warnings, `datatables/${entry.name}`);
        const lower = tableName.toLowerCase();
        if (!tables[lower]) tables[lower] = { name: tableName, keys: [], opaque: false };
        if (res.opaque) {
          tables[lower].opaque = true;
        } else if (res.keys) {
          tables[lower].keys.push(...res.keys);
        }
      }
    }
  } catch { /* no datatables dir */ }

  // parameters/*.json — top level only (mirrors collectParameterJsonFiles).
  try {
    const dir = path.join(modPath, "parameters");
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        const shortName = path.parse(entry.name).name;
        const res = await readJsonKeys(path.join(dir, entry.name), warnings, `parameters/${entry.name}`);
        const lower = shortName.toLowerCase();
        if (!parameters[lower]) parameters[lower] = { name: shortName, keys: [] };
        if (!res.opaque && res.keys) {
          // `$`-prefixed keys are author annotations, not rows.
          parameters[lower].keys.push(...res.keys.filter((k) => !k.startsWith("$")));
        }
      }
    }
  } catch { /* no parameters dir */ }

  // AssetRegistry.json → objectName list
  try {
    const regPath = path.join(modPath, "AssetRegistry.json");
    if (existsSync(regPath)) {
      const res = await readJsonKeys(regPath, warnings, "AssetRegistry.json");
      // Registry is an array; readJsonKeys marks arrays opaque — parse directly.
      if (res.opaque) {
        try {
          const raw = await fs.readFile(regPath, "utf8");
          const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (entry && typeof entry.objectName === "string" && entry.objectName) {
                registry.push(entry.objectName);
              }
            }
          }
        } catch { /* already warned */ }
      }
    }
  } catch { /* ignore */ }

  // Prebuilt packages in mod root (basenames collide in ~mods).
  try {
    const entries = await fs.readdir(modPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (PAK_EXTS.has(path.extname(entry.name).toLowerCase())) {
        prebuilt.push(entry.name);
      }
    }
  } catch { /* ignore */ }

  return { assets, pakAssets, scripts, tables, parameters, registry, prebuilt, warnings };
}

/** Pipeline winner rule: highest priority wins; ties → largest id (pipeline sorts asc, later overwrites). */
function pickWinner(modRefs) {
  const sorted = [...modRefs].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });
  return sorted[sorted.length - 1];
}

function modRef(mod) {
  return { id: mod.id, title: mod.title || mod.id, priority: mod.priority ?? 0 };
}

/**
 * Computes overlaps across enabled mods.
 *
 * @param {Array} mods  Mod objects with {id, title, priority, fullPath, enabled}.
 * @param {{ rescan?: boolean }} opts
 * @returns {Promise<{ total:number, truncated:boolean, conflicts:Array, byMod:Object, scannedMods:number, warnings:Array }>}
 */
async function getConflicts(mods, opts = {}) {
  const { rescan = false } = opts;
  const enabled = (Array.isArray(mods) ? mods : []).filter((m) => m.enabled && m.fullPath);
  const byPath = new Map(enabled.map((m) => [m.fullPath, m]));

  if (rescan) scanCache.clear();
  // Prune cache entries for mods no longer present (folder switches).
  for (const key of scanCache.keys()) {
    if (!byPath.has(key)) scanCache.delete(key);
  }
  // Scan cache misses (sequential to avoid EMFILE spikes).
  for (const mod of enabled) {
    if (!scanCache.has(mod.fullPath)) {
      try {
        scanCache.set(mod.fullPath, await scanMod(mod.fullPath));
      } catch {
        scanCache.set(mod.fullPath, { assets: [], pakAssets: [], scripts: [], tables: {}, parameters: {}, registry: [], prebuilt: [], warnings: [] });
      }
    }
  }

  const assetMap = new Map(); // normRel → modRef[]
  const pakMap = new Map();
  const scriptMap = new Map(); // normRel → { key, mods } (game scripts/)
  const rowMap = new Map(); // normTable + "\0" + normRow → { table, row, mods }
  const paramRowMap = new Map(); // normShort + "\0" + normRow → { shortName, row, mods }
  const tableMods = new Map(); // normTable → { table, mods, opaque: bool }
  const regMap = new Map(); // objectName → modRef[]
  const prebuiltMap = new Map(); // lower basename → modRef[]
  const warnings = [];

  for (const mod of enabled) {
    const ref = modRef(mod);
    const scan = scanCache.get(mod.fullPath);
    if (!scan) continue;
    for (const w of scan.warnings || []) warnings.push(`${mod.id}: ${w}`);

    for (const rel of scan.assets) {
      const k = normKey(rel);
      if (!assetMap.has(k)) assetMap.set(k, { key: rel, mods: [] });
      assetMap.get(k).mods.push(ref);
    }
    for (const rel of scan.pakAssets) {
      const k = normKey(rel);
      if (!pakMap.has(k)) pakMap.set(k, { key: rel, mods: [] });
      pakMap.get(k).mods.push(ref);
    }
    for (const rel of scan.scripts || []) {
      const k = normKey(rel);
      if (!scriptMap.has(k)) scriptMap.set(k, { key: rel, mods: [] });
      scriptMap.get(k).mods.push(ref);
    }
    for (const [lower, t] of Object.entries(scan.tables)) {
      if (!tableMods.has(lower)) tableMods.set(lower, { table: t.name, mods: [], opaque: false });
      const tm = tableMods.get(lower);
      tm.mods.push(ref);
      if (t.opaque) tm.opaque = true;
      for (const rowKey of t.keys || []) {
        const rk = lower + String.fromCharCode(0) + normKey(rowKey);
        if (!rowMap.has(rk)) rowMap.set(rk, { table: t.name, row: rowKey, mods: [] });
        rowMap.get(rk).mods.push(ref);
      }
    }
    for (const [lower, p] of Object.entries(scan.parameters || {})) {
      for (const rowKey of p.keys || []) {
        const rk = lower + String.fromCharCode(0) + normKey(rowKey);
        if (!paramRowMap.has(rk)) paramRowMap.set(rk, { shortName: p.name, row: rowKey, mods: [] });
        paramRowMap.get(rk).mods.push(ref);
      }
    }
    for (const name of scan.registry) {
      if (!regMap.has(name)) regMap.set(name, []);
      regMap.get(name).push(ref);
    }
    for (const base of scan.prebuilt) {
      const k = process.platform === "win32" ? base.toLowerCase() : base;
      if (!prebuiltMap.has(k)) prebuiltMap.set(k, { key: base, mods: [] });
      prebuiltMap.get(k).mods.push(ref);
    }
  }

  const all = [];
  const bump = (byMod, refs, winnerId) => {
    for (const r of refs) {
      if (!byMod[r.id]) byMod[r.id] = { total: 0, wins: 0, overridden: 0 };
      byMod[r.id].total += 1;
      if (r.id === winnerId) byMod[r.id].wins += 1;
      else byMod[r.id].overridden += 1;
    }
  };
  const byMod = {};

  const pushMulti = (type, key, refs, extra = {}) => {
    if (refs.length < 2) return;
    const winner = pickWinner(refs);
    bump(byMod, refs, winner.id);
    all.push({ type, key, mods: refs, winnerId: winner.id, ...extra });
  };

  for (const { key, mods: refs } of assetMap.values()) pushMulti("asset", key, refs);
  for (const { key, mods: refs } of pakMap.values()) pushMulti("pakAsset", key, refs);
  for (const { key, mods: refs } of scriptMap.values()) pushMulti("scripts", key, refs);
  for (const { table, row, mods: refs } of rowMap.values()) {
    pushMulti("datatable", `${table} :: ${row}`, refs, { table, row });
  }
  for (const { shortName, row, mods: refs } of paramRowMap.values()) {
    pushMulti("parameter", `parameters/${shortName} :: ${row}`, refs, { table: `parameters/${shortName}`, row });
  }
  // Opaque tables shared by 2+ mods can't be key-compared → report table-level.
  for (const { table, mods: refs, opaque } of tableMods.values()) {
    if (opaque && refs.length >= 2) {
      pushMulti("datatable", `${table} :: (unresolved rows)`, refs, { table, row: null });
    }
  }
  for (const [name, refs] of regMap.entries()) pushMulti("registry", name, refs);
  for (const { key, mods: refs } of prebuiltMap.values()) pushMulti("prebuilt", key, refs);

  const typeOrder = { datatable: 0, parameter: 1, asset: 2, pakAsset: 3, scripts: 4, registry: 5, prebuilt: 6 };
  all.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.key.localeCompare(b.key));

  // Return ALL overlaps — never truncate, so asset (and every other type of)
  // overlap is always visible in the modal. `truncated` stays false for
  // backwards compatibility with saved/renderer state.
  return {
    total: all.length,
    truncated: false,
    conflicts: all,
    byMod,
    scannedMods: enabled.length,
    warnings: warnings.slice(0, 10),
  };
}

function emptyConflicts() {
  return { total: 0, truncated: false, conflicts: [], byMod: {}, scannedMods: 0, warnings: [] };
}

module.exports = { getConflicts, emptyConflicts, scanMod, MAX_CONFLICTS_RETURNED };
