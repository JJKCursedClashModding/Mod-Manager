/**
 * Conflict detection for enabled mods.
 *
 * Mirrors how the packaging pipeline (packageAllMods.js) merges mods, so
 * only things that really override each other are reported:
 *   - datatables/*.json  → merged PER FIELD: a conflict is two+ mods setting
 *                          the same table + row + top-level field to
 *                          DIFFERENT values (rows/fields case-insensitive,
 *                          like mergeDatatableRows). Rows several mods touch
 *                          with disjoint fields or identical values merge
 *                          cleanly and are only counted (`cleanSharedRows`).
 *   - parameters/*.json  → merged per row (whole row value, exact row key):
 *                          same short name + row with different values
 *   - AssetRegistry.json → same (packageName, objectName), case-insensitive,
 *                          with different entry contents
 *   - assets/**, pak_assets/**, scripts/** → same relative path (copied in
 *                          priority order, so the last copy wins)
 *   - prebuilt *.pak/*.utoc/*.ucas in mod root → same file name in ~mods
 *
 * Winner = the pipeline's last writer: mods are applied priority-ascending
 * with ties broken by folder name (localeCompare), so the highest priority
 * wins and, on equal priority, the alphabetically LAST folder name wins.
 *
 * Performance notes:
 *   - Only ENABLED mods are scanned (disabled mods never reach the pipeline).
 *   - One directory walk per mod for assets/pak_assets/scripts (paths only).
 *   - Datatable/parameter values are reduced to a short comparison signature
 *     (the JSON itself when short, else a SHA-1 of it) plus a preview.
 *   - Per-mod scan results are cached in-memory; toggling mods on/off
 *     recomputes conflicts from cache with zero FS I/O. Pass rescan=true on
 *     refresh / install / folder-change to re-read from disk.
 *   - The full conflict list is always returned (no cap).
 */
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { yieldToEventLoop, existsAsync } = require("./asyncUtils");
const { readJsonFile } = require("./jsonUtils");

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
  let visited = 0;
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip
    }
    // Yield periodically so large trees don't block the main loop.
    if (++visited % 25 === 0) await yieldToEventLoop();
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

/**
 * Reads a mod JSON file for conflict checks.
 * @returns {Promise<{ ok:boolean, value?:any }>}
 */
async function readJsonValue(filePath, warnings, label) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false };
  }
  if (stat.size > MAX_JSON_BYTES) {
    warnings.push(`${label}: skipped, file too large (${Math.round(stat.size / 1024 / 1024)} MB)`);
    return { ok: false };
  }
  try {
    return { ok: true, value: await readJsonFile(filePath) };
  } catch {
    warnings.push(`${label}: skipped, invalid JSON`);
    return { ok: false };
  }
}

const SIG_INLINE_MAX = 256;
const PREVIEW_MAX = 90;

/**
 * Comparison signature + display preview for a JSON value. Equal values
 * give equal signatures (JSON.stringify, the same equality the build's
 * merge warnings use).
 */
function valueSig(value) {
  const json = JSON.stringify(value) ?? "null";
  const sig = json.length <= SIG_INLINE_MAX ? json : `#${crypto.createHash("sha1").update(json).digest("hex")}`;
  // Display only: trim float noise (0.19999999999999998 → 0.2). The signature
  // above still compares exact values.
  const shown = JSON.stringify(value, roundForDisplay) ?? "null";
  const preview = shown.length > PREVIEW_MAX ? `${shown.slice(0, PREVIEW_MAX)}…` : shown;
  return { sig, preview };
}

function roundForDisplay(_key, v) {
  return typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(12)) : v;
}

/** Pseudo field key for a non-object row value (replaces the whole row). */
const WHOLE_ROW = "\u0000row";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Scans a single mod folder. Result is cached by the caller. */
async function scanMod(modPath) {
  const warnings = [];
  const assets = [];
  const pakAssets = [];
  const scripts = [];
  const tables = {}; // lower table name → { name, rows }
  const parameters = {}; // lower short name → { name, rows: Map<row, sig> }
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

  await yieldToEventLoop();
  // datatables/*.json — top level only (mirrors collectDatatableJsonFiles).
  // tables[lowerTable] = { name, rows: Map<lowerRow, { key, fields: Map<lowerField, {key,sig,preview}> }> }
  try {
    const dir = path.join(modPath, "datatables");
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let n = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        const tableName = path.parse(entry.name).name;
        const res = await readJsonValue(path.join(dir, entry.name), warnings, `datatables/${entry.name}`);
        const lower = tableName.toLowerCase();
        if (!tables[lower]) tables[lower] = { name: tableName, rows: new Map() };
        if (res.ok && isPlainObject(res.value)) {
          const rows = tables[lower].rows;
          for (const [rowKey, rowValue] of Object.entries(res.value)) {
            const lowerRow = rowKey.toLowerCase();
            if (!rows.has(lowerRow)) rows.set(lowerRow, { key: rowKey, fields: new Map() });
            const row = rows.get(lowerRow);
            row.key = rowKey;
            if (!isPlainObject(rowValue)) {
              // Not a field map: replaces the whole row in the merge.
              row.fields.set(WHOLE_ROW, { key: null, ...valueSig(rowValue) });
              continue;
            }
            for (const [fieldKey, value] of Object.entries(rowValue)) {
              row.fields.set(fieldKey.toLowerCase(), { key: fieldKey, ...valueSig(value) });
            }
          }
        }
        if (++n % 5 === 0) await yieldToEventLoop();
      }
    }
  } catch { /* no datatables dir */ }
  await yieldToEventLoop();

  // parameters/*.json — top level only (mirrors collectParameterJsonFiles).
  // Rows are merged whole with exact (case-sensitive) row keys.
  try {
    const dir = path.join(modPath, "parameters");
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let n = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        const shortName = path.parse(entry.name).name;
        const res = await readJsonValue(path.join(dir, entry.name), warnings, `parameters/${entry.name}`);
        const lower = shortName.toLowerCase();
        if (!parameters[lower]) parameters[lower] = { name: shortName, rows: new Map() };
        if (res.ok && isPlainObject(res.value)) {
          for (const [rowKey, value] of Object.entries(res.value)) {
            if (rowKey.startsWith("$")) continue; // author annotations, not rows
            parameters[lower].rows.set(rowKey, valueSig(value));
          }
        }
        if (++n % 10 === 0) await yieldToEventLoop();
      }
    }
  } catch { /* no parameters dir */ }
  await yieldToEventLoop();

  // AssetRegistry.json → (packageName, objectName) identities
  try {
    const regPath = path.join(modPath, "AssetRegistry.json");
    if (await existsAsync(regPath)) {
      const res = await readJsonValue(regPath, warnings, "AssetRegistry.json");
      if (res.ok && Array.isArray(res.value)) {
        for (const entry of res.value) {
          // Same identity + selection as combineAssetRegistries / the patcher.
          if (typeof entry?.objectName !== "string" || !entry.objectName) continue;
          const key = registryIdentityKey(entry);
          if (key) {
            registry.push({ key, name: `${entry.packageName} :: ${entry.objectName}`, ...valueSig(entry) });
          }
        }
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
    for (const problem of describePrebuiltProblems(prebuilt)) warnings.push(problem);
  } catch { /* ignore */ }

  return { assets, pakAssets, scripts, tables, parameters, registry, prebuilt, warnings };
}

/**
 * Asset identity used by the build and the AssetRegistryPatcher
 * (assetIdentityKey): ASCII-lowercased `packageName \x1f objectName`.
 * Null for entries the build does not register (missing/non-string names).
 */
function registryIdentityKey(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { packageName, objectName } = entry;
  if (typeof packageName !== "string" || !packageName || typeof objectName !== "string" || !objectName) {
    return null;
  }
  return `${packageName}\x1f${objectName}`.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Base name of the package the build generates into ~mods. */
const GENERATED_PACKAGE_BASE = "zModLoader_P";

/**
 * Problems with a mod's root-level prebuilt packages, mirroring the checks
 * in deploy.collectPrebuiltPackages: a name that collides with the
 * generated package fails the build; an incomplete IoStore set (.utoc/.ucas
 * without all of .pak/.utoc/.ucas) is skipped. A lone .pak is fine.
 *
 * @param {string[]} fileNames  Root-level .pak/.utoc/.ucas file names.
 * @returns {string[]}
 */
function describePrebuiltProblems(fileNames) {
  const problems = [];
  const byBase = new Map();
  for (const name of fileNames) {
    const ext = path.extname(name).toLowerCase();
    const base = name.slice(0, -ext.length);
    const key = base.toLowerCase();
    if (!byBase.has(key)) byBase.set(key, { base, exts: new Set() });
    byBase.get(key).exts.add(ext);
  }
  for (const { base, exts } of byBase.values()) {
    if (base.toLowerCase() === GENERATED_PACKAGE_BASE.toLowerCase()) {
      problems.push(
        `prebuilt ${base}.* uses the manager's generated package name; rename it (the build refuses to overwrite the generated package)`,
      );
      continue;
    }
    const complete = exts.has(".pak") && exts.has(".utoc") && exts.has(".ucas");
    if ((exts.has(".utoc") || exts.has(".ucas")) && !complete) {
      const missing = [".pak", ".utoc", ".ucas"].filter((e) => !exts.has(e)).map((e) => `${base}${e}`);
      problems.push(`prebuilt ${base} is an incomplete IoStore set (missing ${missing.join(", ")}); it will be skipped`);
    }
  }
  return problems;
}

/**
 * Pipeline order (packageAllMods): priority ascending, ties broken by folder
 * id with localeCompare. Later mods overwrite earlier ones, so the LAST mod
 * in this order wins.
 */
function pipelineOrder(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.localeCompare(b.id);
}

function modRef(mod) {
  return { id: mod.id, title: mod.title || mod.id, priority: mod.priority ?? 0 };
}

/**
 * Given one contribution per mod in pipeline order ({ ref, sig, preview }),
 * returns a conflict payload when 2+ different values are set, else null.
 * Winner = last contribution. `tie` is true when the winner only wins by the
 * folder-name tie-break (another mod with a different value has the same
 * priority).
 */
function valueConflict(values) {
  if (values.length < 2) return null;
  const distinct = new Set(values.map((v) => v.sig));
  if (distinct.size < 2) return null;
  const winner = values[values.length - 1];
  const tie = values.some((v) => v.ref.id !== winner.ref.id && v.sig !== winner.sig && v.ref.priority === winner.ref.priority);
  return {
    mods: values.map((v) => ({ ...v.ref, value: v.preview, same: v.sig === winner.sig })),
    winnerId: winner.ref.id,
    tie,
  };
}

/**
 * Computes conflicts across enabled mods.
 *
 * @param {Array} mods  Mod objects with {id, title, priority, fullPath, enabled}.
 * @param {{ rescan?: boolean }} opts
 * @returns {Promise<{ total:number, truncated:boolean, conflicts:Array, byMod:Object, scannedMods:number, cleanSharedRows:number, warnings:Array }>}
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
  // Scan cache misses (sequential to avoid EMFILE spikes). Each scan
  // yields internally, plus one yield per mod here so the main loop can
  // flush IPC and the renderer never observes a hung main process.
  for (const mod of enabled) {
    if (!scanCache.has(mod.fullPath)) {
      try {
        scanCache.set(mod.fullPath, await scanMod(mod.fullPath));
      } catch {
        scanCache.set(mod.fullPath, { assets: [], pakAssets: [], scripts: [], tables: {}, parameters: {}, registry: [], prebuilt: [], warnings: [] });
      }
      await yieldToEventLoop();
    }
  }

  // Walk mods in the pipeline's merge order so every per-key list is
  // already ordered loser → winner.
  const ordered = enabled.map((m) => ({ mod: m, ref: modRef(m) })).sort((a, b) => pipelineOrder(a.ref, b.ref));

  const assetMap = new Map(); // normRel → { key, mods }
  const pakMap = new Map();
  const scriptMap = new Map(); // game scripts/
  const rowMap = new Map(); // lowerTable \0 lowerRow → { table, entries: [{ ref, row }] }
  const paramRowMap = new Map(); // lowerShort \0 row → { shortName, row, values: [{ref,sig,preview}] }
  const regMap = new Map(); // registryIdentityKey → { key, values }
  const prebuiltMap = new Map(); // lower basename → { key, mods }
  const warnings = [];

  let processedMods = 0;
  for (const { mod, ref } of ordered) {
    const scan = scanCache.get(mod.fullPath);
    if (!scan) continue;
    // Yield between mods so very large libraries don't block one turn.
    if (++processedMods % 5 === 0) await yieldToEventLoop();
    for (const w of scan.warnings || []) warnings.push(`${mod.id}: ${w}`);

    const addPath = (map, rel) => {
      const k = normKey(rel);
      if (!map.has(k)) map.set(k, { key: rel, mods: [] });
      map.get(k).mods.push(ref);
    };
    for (const rel of scan.assets) addPath(assetMap, rel);
    for (const rel of scan.pakAssets) addPath(pakMap, rel);
    for (const rel of scan.scripts || []) addPath(scriptMap, rel);

    for (const [lowerTable, t] of Object.entries(scan.tables || {})) {
      if (!(t.rows instanceof Map)) continue;
      for (const [lowerRow, row] of t.rows) {
        const rk = `${lowerTable}\0${lowerRow}`;
        if (!rowMap.has(rk)) rowMap.set(rk, { table: t.name, entries: [] });
        rowMap.get(rk).entries.push({ ref, row });
      }
    }
    for (const [lowerShort, p] of Object.entries(scan.parameters || {})) {
      if (!(p.rows instanceof Map)) continue;
      for (const [rowKey, v] of p.rows) {
        const rk = `${lowerShort}\0${rowKey}`;
        if (!paramRowMap.has(rk)) paramRowMap.set(rk, { shortName: p.name, row: rowKey, values: [] });
        paramRowMap.get(rk).values.push({ ref, sig: v.sig, preview: v.preview });
      }
    }
    // Within a mod the last entry per identity wins (combineAssetRegistries).
    const lastRegistry = new Map();
    for (const item of scan.registry || []) {
      if (item && typeof item.key === "string") lastRegistry.set(item.key, item);
    }
    for (const [key, item] of lastRegistry) {
      if (!regMap.has(key)) regMap.set(key, { key: item.name, values: [] });
      regMap.get(key).values.push({ ref, sig: item.sig, preview: item.preview });
    }
    for (const base of scan.prebuilt) {
      const k = process.platform === "win32" ? base.toLowerCase() : base;
      if (!prebuiltMap.has(k)) prebuiltMap.set(k, { key: base, mods: [] });
      prebuiltMap.get(k).mods.push(ref);
    }
  }

  const all = [];
  const byMod = {};
  const record = (type, key, payload, extra = {}) => {
    for (const r of payload.mods) {
      if (!byMod[r.id]) byMod[r.id] = { total: 0, wins: 0, overridden: 0 };
      byMod[r.id].total += 1;
      if (r.id === payload.winnerId) byMod[r.id].wins += 1;
      else byMod[r.id].overridden += 1;
    }
    all.push({ type, key, ...payload, ...extra });
  };
  const recordPaths = (type, map) => {
    for (const { key, mods: refs } of map.values()) {
      if (refs.length < 2) continue;
      const winner = refs[refs.length - 1];
      const tie = refs.some((r) => r.id !== winner.id && r.priority === winner.priority);
      record(type, key, { mods: refs, winnerId: winner.id, tie });
    }
  };

  // Datatables: per field, only rows 2+ mods touch.
  let cleanSharedRows = 0;
  let rowsChecked = 0;
  for (const { table, entries } of rowMap.values()) {
    if (entries.length < 2) continue;
    if (++rowsChecked % 250 === 0) await yieldToEventLoop();
    const rowKey = entries[entries.length - 1].row.key; // highest-priority spelling
    const fields = new Map(); // lowerField → { key, values }
    for (const { ref, row } of entries) {
      for (const [lowerField, f] of row.fields) {
        if (!fields.has(lowerField)) fields.set(lowerField, { key: f.key, values: [] });
        const field = fields.get(lowerField);
        if (f.key !== null) field.key = f.key;
        field.values.push({ ref, sig: f.sig, preview: f.preview });
      }
    }
    let rowConflicts = 0;
    for (const [lowerField, { key: fieldKey, values }] of fields) {
      const payload = valueConflict(values);
      if (!payload) continue;
      rowConflicts += 1;
      const fieldLabel = lowerField === WHOLE_ROW ? "(whole row)" : fieldKey;
      record("datatable", `${table} :: ${rowKey} › ${fieldLabel}`, payload, { table, row: rowKey, field: fieldLabel });
    }
    if (rowConflicts === 0) cleanSharedRows += 1;
  }

  for (const { shortName, row, values } of paramRowMap.values()) {
    if (values.length < 2) continue;
    const payload = valueConflict(values);
    if (!payload) {
      cleanSharedRows += 1;
      continue;
    }
    record("parameter", `parameters/${shortName} :: ${row}`, payload, { table: `parameters/${shortName}`, row });
  }
  for (const { key, values } of regMap.values()) {
    const payload = valueConflict(values);
    if (payload) record("registry", key, payload);
  }
  recordPaths("asset", assetMap);
  recordPaths("pakAsset", pakMap);
  recordPaths("scripts", scriptMap);
  recordPaths("prebuilt", prebuiltMap);

  const typeOrder = { datatable: 0, parameter: 1, asset: 2, pakAsset: 3, scripts: 4, registry: 5, prebuilt: 6 };
  all.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.key.localeCompare(b.key));

  // Return ALL conflicts — never truncate. `truncated` stays false for
  // backwards compatibility with renderer state.
  return {
    total: all.length,
    truncated: false,
    conflicts: all,
    byMod,
    scannedMods: enabled.length,
    cleanSharedRows,
    warnings: warnings.slice(0, 10),
  };
}

function emptyConflicts() {
  return { total: 0, truncated: false, conflicts: [], byMod: {}, scannedMods: 0, cleanSharedRows: 0, warnings: [] };
}

module.exports = {
  getConflicts,
  emptyConflicts,
  scanMod,
  pipelineOrder,
  registryIdentityKey,
  describePrebuiltProblems,
  GENERATED_PACKAGE_BASE,
  MAX_CONFLICTS_RETURNED,
};
