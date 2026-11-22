const fs = require("fs/promises");
const path = require("path");
const { yieldToEventLoop, existsAsync } = require("./asyncUtils");
const {
  APP_DIR,
  BASE_REGISTRY_BIN,
  BUILD_DIR,
  RETOC_AES_KEY,
  RETOC_ENGINE_VERSION,
  REPAK_VERSION,
  REPAK_MOUNT_POINT,
  DATA_DIR,
  DATATABLES_DIR,
  PARAMETERS_DIR,
  PARAMETERS_MANIFEST,
} = require("./constants");
const { retocPathAsync, repakPathAsync, runCommand } = require("./tools");
const { pathToFileURL } = require("url");
const { ensureDirectory, listModDirectoryNames, readModManifestJson, resolveGamePaksModsDir, resolveGameScriptsDir } = require("./modUtils");
const { registryIdentityKey, GENERATED_PACKAGE_BASE } = require("./conflicts");
const { parseJsonText } = require("./jsonUtils");
const { planDeployment, deployPlannedFiles, DEPLOY_MANIFEST_FILE } = require("./deploy");

async function resolveBundledUsmapPath() {
  const candidates = [
    path.join(APP_DIR, "CookedDatatablePatcher", "mappings.usmap"),
    path.resolve(__dirname, "../CookedDatatablePatcher/mappings.usmap"),
  ];
  for (const candidate of candidates) {
    if (await existsAsync(candidate)) return candidate;
  }
  return candidates[0];
}

// ─── Step 1 – Collect datatable JSON files ────────────────────────────────────

/**
 * Walks every enabled mod's `datatables/` folder and groups all JSON files by
 * their base filename (e.g. "AttackSetDataTable").  Files with the same base
 * name across multiple mods will be merged together in the next step.
 *
 * Grouping is case-insensitive (AttackSetDataTable.json and
 * attacksetdatatable.json are the same table, as on NTFS and in
 * conflicts.js). The group's canonical name is the cooked base table's real
 * name when one exists in DATATABLES_DIR, else the first spelling seen.
 *
 * @param {Array} mods  Enabled mod objects (must have `.fullPath` and `.enabled`).
 * @returns {Map<string, string[]>}  tableName → [absoluteFilePath, …]
 */
async function collectDatatableJsonFiles(mods) {
  /** lower(tableName) → { name, files } */
  const groups = new Map();

  for (const mod of mods) {
    if (!mod.enabled) continue;

    const datatableDir = path.join(mod.fullPath, "datatables");
    if (!(await ensureDirectory(datatableDir))) continue;

    const entries = await fs.readdir(datatableDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;

      const abs = path.join(datatableDir, entry.name);
      const tableName = path.parse(entry.name).name;
      const key = tableName.toLowerCase();

      if (!groups.has(key)) groups.set(key, { name: tableName, files: [] });
      groups.get(key).files.push(abs);
    }
  }

  const cookedByLower = new Map();
  if (groups.size > 0) {
    try {
      for (const e of await fs.readdir(DATATABLES_DIR, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase().endsWith(".uasset")) {
          const base = e.name.replace(/\.uasset$/i, "");
          cookedByLower.set(base.toLowerCase(), base);
        }
      }
    } catch {
      /* missing bases are reported by patchCookedDatatables */
    }
  }

  const filesByTable = new Map();
  for (const [key, group] of groups) {
    filesByTable.set(cookedByLower.get(key) ?? group.name, group.files);
  }
  return filesByTable;
}

// ─── Step 2 – Combine datatable JSON files into a temp patch dir ───────────────

/**
 * For each datatable name collected in the previous step, reads all JSON files
 * that share that name (one per mod), merges them, and writes a single
 * combined JSON file into `outDir` (a temp folder used as CookedDatatablePatcher
 * input).  If `outDir` is null the step is skipped and 0 is returned.
 *
 * Merging is per field within each row: files arrive priority-ascending, so a
 * later (higher-priority) file wins per field, while fields only a
 * lower-priority mod sets are kept. Field values (including arrays and
 * structs) are replaced as whole values. Row keys and field keys fold
 * case-insensitively, matching the patcher (UE FNames/property names are
 * case-insensitive), so case variants merge into one row in priority order;
 * the highest-priority spelling is kept. Every field overwritten with a
 * different value is reported as a warning (like the parameters/ merge).
 *
 * @param {Map<string, string[]>} filesByTable  Output of collectDatatableJsonFiles.
 * @param {string|null} outDir  Absolute path to the destination directory.
 * @param {Function|null} reporter
 * @returns {number}  Number of distinct tables written.
 */
async function combineDatatableJsonFiles(filesByTable, outDir, reporter = null) {
  if (filesByTable.size === 0 || !outDir) return 0;

  await fs.mkdir(outDir, { recursive: true });

  let combinedCount = 0;

  for (const [tableName, filePaths] of filesByTable.entries()) {
    const contributions = [];
    for (const filePath of filePaths) {
      const parsed = await readJsonFileWithContext(filePath);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        contributions.push({ source: modIdFromDatatablePath(filePath), rows: parsed });
      }
    }
    const { combined, warnings } = mergeDatatableRows(contributions);
    for (const w of warnings) {
      reporter?.({
        type: "log",
        stream: "warn",
        message:
          `datatables/${tableName}.json row "${w.row}" field "${w.field}": ` +
          `higher-priority mod "${w.winner}" wins over ${w.overridden.map((m) => `"${m}"`).join(", ")}`,
      });
    }

    const outPath = path.join(outDir, `${tableName}.json`);
    await fs.writeFile(outPath, JSON.stringify(combined, null, 2), "utf8");

    combinedCount += 1;
  }

  return combinedCount;
}

/** `<mods>/<modId>/datatables/<Table>.json` -> `<modId>` (for conflict messages). */
function modIdFromDatatablePath(filePath) {
  return path.basename(path.dirname(path.dirname(filePath)));
}

function isPlainJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Per-field merge of datatable patch documents.
 *
 * @param {Array<{source:string, rows:object}>} contributions  Priority-ascending.
 * @returns {{ combined:object, warnings:Array<{row:string,field:string,winner:string,overridden:string[]}> }}
 */
function mergeDatatableRows(contributions) {
  /** lower(row) -> { key, fields: Map<lower(field), {key, value, source}> } | { key, whole, source } */
  const rows = new Map();
  /** JSON [lowerRow, lowerField] -> { row, field, winner, overridden[] } */
  const conflicts = new Map();

  const noteConflict = (rowKey, lowerRow, fieldKey, lowerField, previousSource, winner) => {
    const id = JSON.stringify([lowerRow, lowerField]);
    const entry = conflicts.get(id) ?? { row: rowKey, field: fieldKey, winner, overridden: [] };
    entry.row = rowKey;
    entry.field = fieldKey;
    entry.winner = winner;
    if (!entry.overridden.includes(previousSource)) entry.overridden.push(previousSource);
    conflicts.set(id, entry);
  };

  for (const { source, rows: doc } of contributions) {
    for (const [rowKey, rowValue] of Object.entries(doc)) {
      const lowerRow = rowKey.toLowerCase();
      let row = rows.get(lowerRow);
      if (!isPlainJsonObject(rowValue)) {
        // Not a field map (the patcher rejects it): last writer wins whole.
        rows.set(lowerRow, { key: rowKey, fields: null, whole: rowValue });
        continue;
      }
      if (!row || row.fields === null) {
        row = { key: rowKey, fields: new Map() };
        rows.set(lowerRow, row);
      }
      row.key = rowKey; // highest-priority spelling wins
      for (const [fieldKey, value] of Object.entries(rowValue)) {
        const lowerField = fieldKey.toLowerCase();
        const previous = row.fields.get(lowerField);
        if (previous && previous.source !== source && JSON.stringify(previous.value) !== JSON.stringify(value)) {
          noteConflict(rowKey, lowerRow, fieldKey, lowerField, previous.source, source);
        }
        row.fields.set(lowerField, { key: fieldKey, value, source });
      }
    }
  }

  const combined = {};
  for (const row of rows.values()) {
    if (row.fields === null) {
      combined[row.key] = row.whole;
      continue;
    }
    const fields = {};
    for (const f of row.fields.values()) fields[f.key] = f.value;
    combined[row.key] = fields;
  }
  return { combined, warnings: [...conflicts.values()] };
}

// ─── Step 2c – Collect per-mod Blueprint parameter JSON files ─────────────────

/**
 * Walks every enabled mod's `parameters/` folder and groups all JSON files by
 * their short name (e.g. "character" for `character.json`). Files with the
 * same short name across multiple mods are merged in the next step
 * (priority-ascending; higher priority wins per row key).
 *
 * Valid short names (see CookedDatatablePatcher/src/bpdata/parameters.ts):
 * sceneCapture, character, storyDemo, exchangeImage, dynamicIcon.
 *
 * @param {Array} mods  Enabled mod objects (must have `.id`, `.fullPath`, `.priority`).
 * @returns {Map<string, Array<{modId:string, priority:number, filePath:string}>>}
 */
async function collectParameterJsonFiles(mods) {
  const filesByShort = new Map();
  // Case-insensitive grouping ("Character.json" == "character.json"); the
  // first spelling seen names the group. patchCookedParameters maps it to the
  // patcher's canonical short name.
  const nameByLower = new Map();

  for (const mod of mods) {
    if (!mod.enabled) continue;

    const parametersDir = path.join(mod.fullPath, "parameters");
    if (!(await ensureDirectory(parametersDir))) continue;

    const entries = await fs.readdir(parametersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;

      const fileShortName = path.parse(entry.name).name;
      if (!nameByLower.has(fileShortName.toLowerCase())) {
        nameByLower.set(fileShortName.toLowerCase(), fileShortName);
      }
      const shortName = nameByLower.get(fileShortName.toLowerCase());
      if (!filesByShort.has(shortName)) filesByShort.set(shortName, []);
      filesByShort.get(shortName).push({
        modId: mod.id,
        priority: mod.priority ?? 0,
        filePath: path.join(parametersDir, entry.name),
      });
    }
  }

  // Pipeline order within each file: lowest priority first so higher-priority
  // mods overwrite the same row keys (mirrors combineDatatableJsonFiles).
  for (const list of filesByShort.values()) {
    list.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.modId.localeCompare(b.modId);
    });
  }

  return filesByShort;
}

// ─── Step 2d – Combine parameter JSON files into a temp patch dir ──────────────

/**
 * Merges same-named `parameters/*.json` files (row-dump shape
 * `{ "CP_300": { "from": "CP_010" } }`) into one file per short name in
 * `outDir` for the BP patcher. Same row key in several mods → highest
 * priority wins; every overwrite is reported as a warning.
 *
 * @returns {{ combined:number, warnings:Array<{shortName:string,row:string,winner:string,overridden:string[]}> }}
 */
async function combineParameterJsonFiles(filesByShort, outDir) {
  const warnings = [];
  if (filesByShort.size === 0 || !outDir) return { combined: 0, warnings };

  await fs.mkdir(outDir, { recursive: true });

  let combined = 0;
  for (const [shortName, contributors] of filesByShort.entries()) {
    const merged = {};
    const winnerByRow = new Map();
    const overriddenByRow = new Map();
    for (const { modId, filePath } of contributors) {
      const parsed = await readJsonFileWithContext(filePath);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`parameters/${shortName}.json must be an object of newID -> row value in ${filePath}`);
      }
      for (const [row, value] of Object.entries(parsed)) {
        if (row.startsWith("$")) continue; // author annotations, not rows
        if (Object.prototype.hasOwnProperty.call(merged, row)) {
          if (!overriddenByRow.has(row)) overriddenByRow.set(row, []);
          overriddenByRow.get(row).push(winnerByRow.get(row));
        }
        merged[row] = value;
        winnerByRow.set(row, modId);
      }
    }
    for (const [row, overridden] of overriddenByRow.entries()) {
      warnings.push({ shortName, row, winner: winnerByRow.get(row), overridden });
    }
    await fs.writeFile(path.join(outDir, `${shortName}.json`), JSON.stringify(merged, null, 2), "utf8");
    combined += 1;
  }

  return { combined, warnings };
}

// ─── Step 2e – Patch cooked Blueprint parameters via CookedDatatablePatcher ────

/**
 * Loads the BP patcher and applies merged `parameters/*.json` patches to the
 * pristine cooked `.uasset`/`.uexp` pairs in `PARAMETERS_DIR`, writing patched
 * assets into the IoStore staging Content/Widgets/Commons folder. Only
 * touched assets are emitted. Base hashes are verified against
 * `PARAMETERS_MANIFEST` first (fails loudly on game updates).
 *
 * @param {string} parametersDir  Temp dir of merged `<short>.json` files.
 * @param {string} outputDir      Staging path for patched parameter assets.
 * @param {Function|null} reporter
 * @returns {Promise<{ patched:number, details:Array }>} 
 */
async function findFirstExisting(candidates) {
  for (const candidate of candidates) {
    if (await existsAsync(candidate)) return candidate;
  }
  return null;
}

async function patchCookedParameters(parametersDir, outputDir, reporter = null) {
  if (!(await existsAsync(PARAMETERS_DIR))) {
    throw new Error(`Missing cooked parameter bases directory at ${PARAMETERS_DIR}`);
  }

  const patcherCandidates = [
    path.join(APP_DIR, "CookedDatatablePatcher", "dist", "index.js"),
    path.resolve(__dirname, "../CookedDatatablePatcher/dist/index.js"),
  ];
  const patcherPath = await findFirstExisting(patcherCandidates);
  if (!patcherPath) {
    throw new Error(
      "Missing BP parameter patcher build output. Expected CookedDatatablePatcher/dist/index.js in app resources.",
    );
  }

  const { patchBpParameter, verifyBaseManifest, ASSET_BY_SHORT_NAME, parseUsmap, SchemaRegistry } =
    await import(pathToFileURL(patcherPath).href);

  await fs.mkdir(outputDir, { recursive: true });

  verifyBaseManifest(PARAMETERS_DIR, PARAMETERS_MANIFEST);
  await yieldToEventLoop();

  // Parse the usmap once and share it across every asset.
  const usmapBuf = await fs.readFile(await resolveBundledUsmapPath());
  const registry = new SchemaRegistry(parseUsmap(usmapBuf));
  await yieldToEventLoop();

  const entries = await fs.readdir(parametersDir, { withFileTypes: true });
  const shorts = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/i, ""))
    .sort((a, b) => a.localeCompare(b));

  const patched = [];
  const skipped = [];
  const errors = [];
  // Parameter file names are matched case-insensitively ("Character.json").
  const canonicalShortByLower = new Map([...ASSET_BY_SHORT_NAME.keys()].map((k) => [k.toLowerCase(), k]));
  for (let i = 0; i < shorts.length; i++) {
    const fileShortName = shorts[i];
    const shortName = canonicalShortByLower.get(fileShortName.toLowerCase());
    if (!shortName) {
      const valid = [...ASSET_BY_SHORT_NAME.keys()].join(", ");
      errors.push({ shortName: fileShortName, error: `unknown parameter file; expected one of: ${valid}` });
      continue;
    }
    const patchPath = path.join(parametersDir, `${fileShortName}.json`);
    const rawText = await fs.readFile(patchPath, "utf8");
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (err) {
      errors.push({ shortName, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
      skipped.push(shortName);
      continue;
    }
    reporter?.({
      type: "progress",
      step: `Patching cooked parameters (${i + 1}/${shorts.length})`,
      progress: 68,
    });
    await yieldToEventLoop();
    try {
      patched.push(
        patchBpParameter({
          inputDir: PARAMETERS_DIR,
          outputDir,
          shortName,
          patchJsonPath: patchPath,
          registry,
        }),
      );
    } catch (err) {
      errors.push({ shortName, error: err instanceof Error ? err.message : String(err) });
    }
    await yieldToEventLoop();
  }

  if (errors.length > 0) {
    const details = errors.map((e) => `${e.shortName}: ${e.error}`).join("\n");
    throw new Error(`Cooked parameter patch failed:\n${details}`);
  }

  for (const r of patched) {
    reporter?.({
      type: "log",
      stream: "info",
      message: `parameters/${r.shortName}: added=${r.added} replaced=${r.replaced} skipped=${r.skipped}`,
    });
  }
  await yieldToEventLoop();

  return { patched: patched.length, details: patched };
}

/** Game-relative paths of the 5 merged parameter assets (migrate to parameters/). */
const MANAGED_PARAMETER_ASSET_PATHS = new Set(
  [
    "GameWidgetSceneCaptureParameter_BP",
    "GameWidgetCharacterParameter_BP",
    "GameWidgetStoryDemoParameter_BP",
    "GameWidgetExchangeImageParameter_BP",
    "GameWidgetDynamicIconParameter_BP",
  ].map((n) => `jujutsu kaisen cc/content/widgets/commons/${n.toLowerCase()}.uasset`),
);

/**
 * Warns when an enabled mod ships a whole copy of a manager-merged parameter
 * asset under `assets/` (it would be overwritten by the merged build output).
 *
 * @returns {string[]}  Warning messages (also reported via `reporter`).
 */
async function warnOnManagedParameterAssets(enabledMods, reporter = null) {
  const warnings = [];
  for (const mod of enabledMods) {
    if (!mod.enabled) continue;
    const assetsDir = path.join(mod.fullPath, "assets");
    if (!(await ensureDirectory(assetsDir))) continue;
    const stack = [""];
    while (stack.length > 0) {
      const rel = stack.pop();
      const abs = rel ? path.join(assetsDir, rel) : assetsDir;
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          stack.push(childRel);
        } else if (entry.isFile() && MANAGED_PARAMETER_ASSET_PATHS.has(childRel.toLowerCase())) {
          warnings.push(
            `${mod.id}: assets/${childRel} is a manager-merged parameter asset and will be overwritten — migrate its rows to parameters/ instead`,
          );
        }
      }
    }
    await yieldToEventLoop();
  }
  for (const message of warnings) {
    reporter?.({ type: "log", stream: "info", message: `Warning: ${message}` });
  }
  return warnings;
}

// ─── Step 2b – Patch cooked DataTables via CookedDatatablePatcher ─────────────

/**
 * Loads CookedDatatablePatcher and applies merged JSON patches to base cooked
 * `.uasset`/`.uexp` pairs from `DATATABLES_DIR`, writing patched assets into
 * the IoStore staging Content/DataTables folder.
 *
 * Tables are patched one at a time with an event-loop yield + progress update
 * between each so the packaging modal stays alive during large batches (the
 * per-table parse/serialize is synchronous CPU work that would otherwise
 * block all `package-progress` IPC until the whole batch finishes).
 *
 * @param {string} modManagerDir  Temp dir of merged `*.json` patch files.
 * @param {string} outputDir      Staging path for patched cooked tables.
 * @param {Function|null} reporter
 * @returns {Promise<{ patched: number }>}
 */
async function patchCookedDatatables(modManagerDir, outputDir, reporter = null) {
  if (!(await existsAsync(DATATABLES_DIR))) {
    throw new Error(`Missing cooked datatables directory at ${DATATABLES_DIR}`);
  }

  const patcherCandidates = [
    path.join(APP_DIR, "CookedDatatablePatcher", "dist", "index.js"),
    path.resolve(__dirname, "../CookedDatatablePatcher/dist/index.js"),
  ];
  const patcherIndexPath = await findFirstExisting(patcherCandidates);
  if (!patcherIndexPath) {
    throw new Error(
      "Missing CookedDatatablePatcher build output. Expected CookedDatatablePatcher/dist/index.js in app resources.",
    );
  }

  const { patchCookedDataTable, parseUsmap, SchemaRegistry } = await import(
    pathToFileURL(patcherIndexPath).href
  );

  await fs.mkdir(outputDir, { recursive: true });

  // Parse the 1.5MB usmap once and share it across every table instead of
  // re-parsing (brotli + deserialize) per table inside the patcher.
  const usmapBuf = await fs.readFile(await resolveBundledUsmapPath());
  const registry = new SchemaRegistry(parseUsmap(usmapBuf));
  await yieldToEventLoop();

  const entries = await fs.readdir(modManagerDir, { withFileTypes: true });
  const tables = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/i, ""))
    .sort((a, b) => a.localeCompare(b));

  const cookedSet = new Set(
    (await fs.readdir(DATATABLES_DIR, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".uasset"))
      .map((e) => e.name.replace(/\.uasset$/i, "")),
  );
  const cookedLower = new Map([...cookedSet].map((n) => [n.toLowerCase(), n]));

  const patched = [];
  const skipped = [];
  const errors = [];
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const cookedName = cookedLower.get(table.toLowerCase());
    if (!cookedName) {
      skipped.push(table);
      continue;
    }
    reporter?.({
      type: "progress",
      step: `Patching cooked DataTables (${i + 1}/${tables.length})`,
      progress: 65,
    });
    // Flush the progress IPC before the blocking patch call.
    await yieldToEventLoop();
    try {
      patched.push(
        patchCookedDataTable({
          inputDir: DATATABLES_DIR,
          outputDir,
          tableAssetName: cookedName,
          patchJsonPath: path.join(modManagerDir, `${table}.json`),
          addRows: true,
          registry,
        }),
      );
    } catch (err) {
      errors.push({ table, error: err instanceof Error ? err.message : String(err) });
    }
    // Let progress/logs flush before the next table blocks the loop again.
    await yieldToEventLoop();
  }

  if (errors.length > 0) {
    const details = errors.map((e) => `${e.table}: ${e.error}`).join("\n");
    throw new Error(`Cooked datatable patch failed:\n${details}`);
  }

  if (skipped.length > 0) {
    throw new Error(
      `Missing cooked base tables for: ${skipped.join(", ")}. ` +
        `Expected matching .uasset/.uexp pairs under ${DATATABLES_DIR}.`,
    );
  }

  reporter?.({
    type: "log",
    stream: "info",
    message: `Patched ${patched.length} cooked datatable(s)`,
  });
  for (const r of patched) {
    const missingRows = r.missingRows ?? [];
    const addedRows = r.addedRows ?? [];
    if (missingRows.length > 0) {
      reporter?.({
        type: "log",
        stream: "error",
        message: `${r.table}: row(s) not found (skipped): ${missingRows.join(", ")}`,
      });
    }
    if (addedRows.length > 0) {
      reporter?.({
        type: "log",
        stream: "info",
        message: `${r.table}: new row(s) added: ${addedRows.join(", ")}`,
      });
    }
    // Miscased field keys are applied to the real field (UE names are
    // case-insensitive) but flagged so mod authors can fix their JSON.
    for (const f of r.fieldCaseFixed ?? []) {
      reporter?.({
        type: "log",
        stream: "warn",
        message: `${r.table}: field "${f.path}.${f.patch}" applied as "${f.canonical}" (wrong capitalisation)`,
      });
    }
    // Keys that match no field are not written at all.
    for (const f of r.unknownFields ?? []) {
      reporter?.({
        type: "log",
        stream: "error",
        message: `${r.table}: field "${f.path}.${f.patch}" does not exist in the table (ignored)`,
      });
    }
  }
  await yieldToEventLoop();

  return { patched: patched.length };
}

// ─── Step 3 – Merge AssetRegistry entries ────────────────────────────────────

/**
 * Reads each enabled mod's `AssetRegistry.json` (an array of asset entries),
 * merges all entries into a single manifest, then calls `applyJsonToAssetRegistry`
 * from AssetRegistryGenerator in-process to bake those entries into the base
 * `AssetRegistry.bin`, producing a new bin at:
 *
 *   <stagingRoot>/Jujutsu Kaisen CC/AssetRegistry.bin
 *
 * @returns {string}  Absolute path to the output AssetRegistry.bin.
 */
async function combineAssetRegistries(enabledMods, stagingRoot, reporter = null) {
  // Gather every mod's AssetRegistry entries, deduplicating by asset identity
  // (packageName, objectName), case-insensitive — the same key the
  // AssetRegistryPatcher and conflicts.js use, so /Game/ModA/T_Icon and
  // /Game/ModB/T_Icon are both kept. Mods are processed in priority-ascending
  // order so later (higher-priority) entries overwrite earlier ones.
  // Entries without an objectName are skipped (as before); entries with one
  // but no packageName/classPath would make the patcher fail with an
  // index-only message, so they are reported here per mod instead.
  const registryByPath = new Map();
  const invalid = [];
  for (const mod of enabledMods) {
    if (!mod.enabled) continue;

    const manifestPath = path.join(mod.fullPath, "AssetRegistry.json");
    if (!(await existsAsync(manifestPath))) continue;

    const parsed = await readJsonFileWithContext(manifestPath);
    if (!Array.isArray(parsed)) {
      throw new Error(`AssetRegistry.json must be an array in ${manifestPath}`);
    }
    parsed.forEach((entry, index) => {
      if (typeof entry?.objectName !== "string" || !entry.objectName) return;
      const key = registryIdentityKey(entry);
      const classPath = typeof entry.classPath === "string" ? entry.classPath.trim() : "";
      if (!key || !classPath) {
        const missing = [!key ? "packageName" : null, !classPath ? "classPath" : null].filter(Boolean);
        invalid.push(`${mod.id}: AssetRegistry.json entry ${index} (${entry.objectName}) is missing ${missing.join(", ")}`);
        return;
      }
      registryByPath.set(key, entry);
    });
    await yieldToEventLoop();
  }
  if (invalid.length > 0) {
    const shown = invalid.slice(0, 10).join("\n");
    const more = invalid.length > 10 ? `\n…and ${invalid.length - 10} more` : "";
    throw new Error(
      `Invalid AssetRegistry.json entries (packageName, objectName and a full classPath such as "/Script/Engine.Texture2D" are required):\n${shown}${more}`,
    );
  }

  const registryRows = [...registryByPath.values()];

  if (!(await existsAsync(BASE_REGISTRY_BIN))) {
    throw new Error(`Missing base AssetRegistry.bin at ${BASE_REGISTRY_BIN}`);
  }

  // The output bin lives at the game-content root inside the staging tree so
  // retoc can find it when packaging.
  const outRegistryPath = path.join(stagingRoot, "Jujutsu Kaisen CC", "AssetRegistry.bin");
  await fs.mkdir(path.dirname(outRegistryPath), { recursive: true });

  // Use AssetRegistryGenerator directly (in-process) instead of spawning jjkue.
  // Prefer APP_DIR so packaged builds can load from resources/, with a source fallback.
  const generatorCandidates = [
    path.join(APP_DIR, "AssetRegistryPatcher", "dist", "index.js"),
    path.resolve(__dirname, "../AssetRegistryPatcher/dist/index.js"),
  ];
  const generatorIndexPath = await findFirstExisting(generatorCandidates);
  if (!generatorIndexPath) {
    throw new Error(
      "Missing AssetRegistryPatcher build output. Expected AssetRegistryPatcher/dist/index.js in app resources.",
    );
  }
  const { applyJsonToAssetRegistry } = await import(pathToFileURL(generatorIndexPath).href);

  const baseBuf = await fs.readFile(BASE_REGISTRY_BIN);
  // Yield so the "Merging AssetRegistry" progress IPC flushes before the
  // synchronous 13MB bin parse/serialize blocks the event loop.
  await yieldToEventLoop();
  const outBuf = applyJsonToAssetRegistry(baseBuf, registryRows);
  await yieldToEventLoop();
  await fs.writeFile(outRegistryPath, outBuf);

  return outRegistryPath;
}

// ─── Step 4 – Copy loose mod assets into staging ─────────────────────────────

/**
 * Copies everything inside each enabled mod's `assets/` folder directly into
 * the staging root.  The assets folder is expected to mirror the UE content
 * tree (e.g. `Jujutsu Kaisen CC/Content/…`) so files land in the right place
 * for retoc to pick them up.
 *
 * @returns {number}  Total number of top-level entries copied.
 */
async function copyAssetsIntoStaging(enabledMods, stagingRoot) {
  let copiedCount = 0;

  for (const mod of enabledMods) {
    if (!mod.enabled) continue;

    const assetsDir = path.join(mod.fullPath, "assets");
    if (!(await ensureDirectory(assetsDir))) continue;

    const entries = await fs.readdir(assetsDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(assetsDir, entry.name);
      const dest = path.join(stagingRoot, entry.name);
      await fs.cp(src, dest, { recursive: true, force: true });
      copiedCount += 1;
    }
    await yieldToEventLoop();
  }

  return copiedCount;
}

// ─── Step 5 – Build IoStore containers via retoc ─────────────────────────────

/**
 * Runs `retoc to-zen` once to convert the staging directory into encrypted
 * IoStore containers (.utoc / .ucas).  Any error is propagated directly.
 *
 * @returns {string}  Absolute path to the produced .utoc file.
 */
async function runRetocToZen(stagingRoot, outputDir, ioBase, reporter = null) {
  const utocPath = path.join(outputDir, `${ioBase}.utoc`);
  await yieldToEventLoop();
  await runCommand(
    await retocPathAsync(),
    [
      "--aes-key",
      RETOC_AES_KEY,
      "to-zen",
      stagingRoot,
      utocPath,
      "--version",
      RETOC_ENGINE_VERSION,
    ],
    APP_DIR,
    { reporter },
  );
  return utocPath;
}

// ─── Step 6a – Copy pak_assets into the registry pak staging dir ─────────────

/**
 * Copies the contents of each enabled mod's `pak_assets/` folder into `destDir`,
 * preserving the relative path structure so files land at the correct mount path
 * inside the .pak.  Higher-priority mods (later in the array) overwrite files
 * from lower-priority mods when there is a conflict.
 *
 * @param {Array}  enabledMods  Enabled mod objects with `.fullPath` (priority-sorted).
 * @param {string} destDir      Destination directory (the __registry_pak temp dir).
 * @returns {number}  Total number of top-level entries copied.
 */
async function copyPakAssetsIntoRegistryPak(enabledMods, destDir) {
  let copiedCount = 0;

  for (const mod of enabledMods) {
    if (!mod.enabled) continue;

    const pakAssetsDir = path.join(mod.fullPath, "pak_assets");
    if (!(await ensureDirectory(pakAssetsDir))) continue;

    const entries = await fs.readdir(pakAssetsDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(pakAssetsDir, entry.name);
      const dest = path.join(destDir, entry.name);
      await fs.cp(src, dest, { recursive: true, force: true });
      copiedCount += 1;
    }
    await yieldToEventLoop();
  }

  return copiedCount;
}

// ─── Step 6 – Pack the AssetRegistry into a .pak via repak ───────────────────

/**
 * Uses `repak pack` to bundle the merged `AssetRegistry.bin`, `DefaultGame.ini`,
 * and any `pak_assets` from enabled mods into a .pak file.
 * The pak is placed alongside the retoc-generated .utoc/.ucas so all three
 * files travel together when deployed to the game.
 *
 * A temporary directory (`__registry_pak/`) is created inside the staging root
 * to give repak a clean, minimal file tree to pack from.
 */
async function runRepakForRegistry(stagingRoot, outputDir, ioBase, enabledMods = [], reporter = null) {
  // Build a minimal staging sub-tree containing only the AssetRegistry.bin so
  // repak produces a pak that mirrors the correct game-content mount path.
  const tempRegistryPackDir = path.join(stagingRoot, "__registry_pak");

  const regMountPath = path.join(tempRegistryPackDir, "Jujutsu Kaisen CC", "AssetRegistry.bin");
  await fs.mkdir(path.dirname(regMountPath), { recursive: true });
  await fs.copyFile(path.join(stagingRoot, "Jujutsu Kaisen CC", "AssetRegistry.bin"), regMountPath);

  const iniMountPath = path.join(tempRegistryPackDir, "Jujutsu Kaisen CC", "Config", "DefaultGame.ini");
  await fs.mkdir(path.dirname(iniMountPath), { recursive: true });
  await fs.copyFile(path.join(DATA_DIR, "DefaultGame.ini"), iniMountPath);

  // Copy pak_assets from all enabled mods into the temp pak staging dir.
  const copiedPakAssets = await copyPakAssetsIntoRegistryPak(enabledMods, tempRegistryPackDir);
  if (copiedPakAssets > 0) {
    reporter?.({ type: "log", stream: "info", message: `Copied ${copiedPakAssets} pak_asset root(s) into registry pak` });
  }

  const pakPath = path.join(outputDir, `${ioBase}.pak`);
  await yieldToEventLoop();
  await runCommand(
    await repakPathAsync(),
    ["pack", tempRegistryPackDir, pakPath, "--version", REPAK_VERSION, "--mount-point", REPAK_MOUNT_POINT],
    APP_DIR,
    { reporter },
  );
}

// ─── Step 7 – Deploy to the game (see lib/deploy.js) ─────────────────────────
//
// Prebuilt mod packages (.pak/.utoc/.ucas in a mod's root) and each mod's
// scripts/ folder (Ultimate ASI Loader plugins) are planned by
// deploy.planDeployment and copied by deploy.deployPlannedFiles only after
// every build step succeeded. ~mods and scripts/ are no longer wiped: only
// files recorded in the deploy manifest are ever removed.

/**
 * Default `global.ini` written into the game `scripts/` dir when none exists.
 * Enables recursive plugin loading so per-mod subfolders work on UAL builds
 * that support it; harmless on builds that only load flat files.
 */
const SCRIPTS_GLOBAL_INI = `[GlobalSets]\nLoadPlugins=1\nLoadRecursively=1\n`;

/**
 * Ensures the game `scripts/` dir exists and has a `global.ini`.
 * An existing user-customized `global.ini` is never overwritten (and is
 * never tracked as a deployed file, so it is never removed).
 */
async function ensureScriptsGlobalIni(scriptsDir, reporter = null) {
  if (!scriptsDir) return;
  await fs.mkdir(scriptsDir, { recursive: true });
  const iniPath = path.join(scriptsDir, "global.ini");
  if (!(await existsAsync(iniPath))) {
    await fs.writeFile(iniPath, SCRIPTS_GLOBAL_INI, "utf8");
    reporter?.({ type: "log", stream: "info", message: "Created scripts/global.ini (LoadRecursively=1)" });
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Main packaging pipeline.  Resolves all enabled mods, runs every step in
 * order, and returns a summary object.
 *
 * Pipeline steps (with approximate progress %):
 *   8  – Prepare output folders
 *  15  – Collect datatable JSON files from mod folders
 *  25  – Combine datatable JSON files → temp patch dir
 *  42  – Merge AssetRegistry entries (AssetRegistryGenerator)
 *  58  – Copy loose mod assets into staging
 *  65  – Patch cooked DataTables into staging (CookedDatatablePatcher; after assets so JSON wins)
 *  68  – Collect + combine parameters/*.json, patch cooked Blueprint parameters
 *  75  – Build IoStore containers (retoc to-zen)
 *  88  – Pack AssetRegistry (repak)
 *  93  – Plan deployment (generated package, prebuilt mod packages, scripts/)
 *  95  – Deploy to Content/Paks/~mods + game scripts/, remove stale
 *        manager-deployed files (deploy manifest; see lib/deploy.js)
 * 100  – Done
 *
 * Nothing in the game folder is touched before every build step succeeded.
 * With no enabled mods there is nothing to build: the deploy step just
 * removes the files the manager previously deployed.
 *
 * @param {string}        modsFolder     Absolute path to the mods workspace.
 * @param {string[]}      enabledModIds  IDs of the mods to include.
 * @param {Function|null} reporter       Progress/log callback.
 * @param {string|null}   gameExePath    Path to the game executable (used to
 *                                       locate Content/Paks/~mods for deployment).
 */
async function packageAllMods(modsFolder, enabledModIds = [], reporter = null, gameExePath = null) {
  // Build the set of enabled mod IDs, filtering out anything malformed.
  const enabledIdSet = new Set(
    Array.isArray(enabledModIds) ? enabledModIds.filter((id) => typeof id === "string" && id) : [],
  );

  const allModIds = await listModDirectoryNames(modsFolder);
  const skipped = allModIds.filter((id) => !enabledIdSet.has(id)).length;

  // Resolve enabled mod metadata.  Priority is read from manifest.json so the
  // pipeline can apply mods in the correct order (lowest priority first so that
  // higher-priority mods overwrite them).  Ties are broken alphabetically.
  const enabledMods = [];
  for (const id of allModIds) {
    if (!enabledIdSet.has(id)) continue;
    const modPath = path.join(modsFolder, id);
    if (!(await ensureDirectory(modPath))) continue;
    const manifest = await readModManifestJson(modPath, id);
    enabledMods.push({ id, folderName: id, fullPath: modPath, enabled: true, priority: manifest.priority ?? 0 });
  }
  // Pipeline order: lowest priority first → highest priority last (overwrites).
  enabledMods.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });

  const ioBase = GENERATED_PACKAGE_BASE; // "zModLoader_P"
  const stagingRoot = path.join(BUILD_DIR, "staging");
  const outputDir = path.join(BUILD_DIR, "output");
  const datatablePatchDir = path.join(BUILD_DIR, "datatable-patches");
  const parameterPatchDir = path.join(BUILD_DIR, "parameter-patches");
  const deployManifestPath = path.join(BUILD_DIR, DEPLOY_MANIFEST_FILE);

  reporter?.({ type: "progress", step: "Preparing output folders", progress: 8 });
  await fs.mkdir(outputDir, { recursive: true });
  // Drop the previous run's package so a failed build can never deploy it.
  for (const ext of [".pak", ".utoc", ".ucas"]) {
    await fs.rm(path.join(outputDir, `${ioBase}${ext}`), { force: true });
  }

  // ~mods and scripts/ are NOT cleared here any more: the build runs fully in
  // staging first and deployToGame() only replaces/removes files the manager
  // itself deployed (tracked in the deploy manifest).
  const gamePaksModsDir = resolveGamePaksModsDir(gameExePath);
  const gameScriptsDir = resolveGameScriptsDir(gameExePath);
  // Every library mod (enabled or not) — used only for the first-run
  // migration when no deploy manifest exists yet (see deploy.js).
  const libraryMods = allModIds.map((id) => ({ id, fullPath: path.join(modsFolder, id) }));

  /** Plans + deploys; returns copy counts. Runs only after a successful build. */
  const deployToGame = async (includeGenerated) => {
    if (!gamePaksModsDir && !gameScriptsDir) {
      reporter?.({ type: "log", stream: "stdout", message: "No game executable path set; skipped deploying to the game." });
      return { copiedPrebuiltPackages: 0, copiedScripts: 0 };
    }
    reporter?.({ type: "progress", step: "Planning deployment", progress: 93 });
    const plan = await planDeployment({ enabledMods, outputDir, ioBase, includeGenerated });
    for (const w of plan.warnings) {
      reporter?.({ type: "log", stream: "warn", message: `Warning: ${w}` });
    }
    reporter?.({ type: "progress", step: "Installing into Content/Paks/~mods and game scripts/", progress: 95 });
    reporter?.({ type: "log", stream: "info", message: `Deploying to ${gamePaksModsDir} and ${gameScriptsDir}…` });
    const deployed = await deployPlannedFiles({
      plan,
      paksDir: gamePaksModsDir,
      scriptsDir: gameScriptsDir,
      manifestPath: deployManifestPath,
      libraryMods,
      ioBase,
      reporter,
    });
    // Keep the existing global.ini handling: create a default one if missing,
    // never overwrite (or remove) a user's.
    await ensureScriptsGlobalIni(gameScriptsDir, reporter);
    const generatedCount = includeGenerated && gamePaksModsDir ? 3 : 0;
    return {
      copiedPrebuiltPackages: Math.max(0, deployed.copiedPaks - generatedCount),
      copiedScripts: deployed.copiedScripts,
      removedFiles: deployed.removed,
    };
  };

  // Clear stale runtime JSON datatable folder from older mod-manager versions.
  // Patched cooked tables now ship inside the IoStore package instead.
  const staleModManagerDir = gameExePath
    ? path.resolve(path.dirname(gameExePath), "../../Content/DataTables/_ModManager")
    : null;
  if (staleModManagerDir) {
    reporter?.({ type: "progress", step: "Clearing stale Content/DataTables/_ModManager", progress: 11 });
    await fs.rm(staleModManagerDir, { recursive: true, force: true });
  }

  // Nothing enabled: nothing to build. Deploy an empty plan, which removes
  // only the files the manager deployed before (hand-placed paks and other
  // ASI plugins stay), and keeps/creates global.ini.
  if (enabledMods.length === 0) {
    reporter?.({ type: "progress", step: "No enabled mods — removing installed mods", progress: 50 });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(datatablePatchDir, { recursive: true, force: true });
    await fs.rm(parameterPatchDir, { recursive: true, force: true });
    const { removedFiles = [] } = await deployToGame(false);
    reporter?.({ type: "progress", step: "Installed mods removed", progress: 100 });
    reporter?.({ type: "log", stream: "info", message: `Done — removed ${removedFiles.length} manager-installed file(s)` });
    return {
      outputDir,
      count: 0,
      skipped,
      combinedTables: 0,
      patchedTables: 0,
      combinedParameters: 0,
      patchedParameters: 0,
      parameterWarnings: [],
      copiedAssetRoots: 0,
      mergedRegistry: null,
      gamePaksModsDir,
      gameScriptsDir,
      copiedPrebuiltPackages: 0,
      copiedScripts: 0,
      utocPath: path.join(outputDir, `${ioBase}.utoc`),
      ucasPath: path.join(outputDir, `${ioBase}.ucas`),
      pakPath: path.join(outputDir, `${ioBase}.pak`),
    };
  }

  // Start with a clean staging directory on every run.
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.rm(datatablePatchDir, { recursive: true, force: true });
  await fs.rm(parameterPatchDir, { recursive: true, force: true });

  // ── Datatable JSON collect/merge ──────────────────────────────────────────
  // Collect all JSON files from mod `datatables/` folders, grouped by name.
  reporter?.({ type: "progress", step: "Collecting datatable JSON files", progress: 15 });
  reporter?.({ type: "log", stream: "info", message: "Collecting datatable JSON files from enabled mods…" });
  const filesByTable = await collectDatatableJsonFiles(enabledMods);

  // Merge same-named files into a temp patch directory for CookedDatatablePatcher.
  reporter?.({ type: "progress", step: "Combining datatable JSON files", progress: 25 });
  reporter?.({ type: "log", stream: "info", message: `Combining datatable JSON files → ${datatablePatchDir}` });
  const combinedTables = await combineDatatableJsonFiles(filesByTable, datatablePatchDir, reporter);
  if (combinedTables > 0) {
    reporter?.({ type: "log", stream: "info", message: `Combined ${combinedTables} datatable(s)` });
  }

  // ── Asset registry ────────────────────────────────────────────────────────
  // Merge each mod's AssetRegistry.json entries into one bin via AssetRegistryGenerator.
  reporter?.({ type: "progress", step: "Merging AssetRegistry entries", progress: 42 });
  reporter?.({ type: "log", stream: "info", message: "Merging AssetRegistry entries…" });
  await yieldToEventLoop();
  const mergedRegistry = await combineAssetRegistries(enabledMods, stagingRoot, reporter);

  // ── Loose assets ─────────────────────────────────────────────────────────
  // Copy each mod's `assets/` folder contents into the staging tree.
  reporter?.({ type: "progress", step: "Copying mod assets into staging", progress: 58 });
  reporter?.({ type: "log", stream: "info", message: "Copying loose mod assets into staging…" });
  const copiedAssetRoots = await copyAssetsIntoStaging(enabledMods, stagingRoot);
  if (copiedAssetRoots > 0) {
    reporter?.({ type: "log", stream: "info", message: `Copied ${copiedAssetRoots} asset root(s)` });
  }

  // ── Cooked datatable patch (after assets) ─────────────────────────────────
  // Must run after copyAssetsIntoStaging so JSON patches overwrite any cooked
  // DataTables that mods may have shipped under assets/Content/DataTables.
  let patchedTables = 0;
  if (combinedTables > 0) {
    const cookedOutputDir = path.join(stagingRoot, "Jujutsu Kaisen CC", "Content", "DataTables");
    reporter?.({ type: "progress", step: "Patching cooked DataTables", progress: 65 });
    reporter?.({ type: "log", stream: "info", message: `Patching cooked DataTables → ${cookedOutputDir}` });
    await yieldToEventLoop();
    const patchResult = await patchCookedDatatables(datatablePatchDir, cookedOutputDir, reporter);
    patchedTables = patchResult.patched;
  }

  // ── Blueprint parameter merge + patch (after assets) ───────────────────────
  // Collect each mod's parameters/*.json rows, merge per short name
  // (highest priority wins), then clone donor rows into the pristine bases.
  // Runs after copyAssetsIntoStaging so merged output wins over any whole
  // parameter asset a mod may still ship under assets/ (warned below).
  reporter?.({ type: "progress", step: "Collecting parameter JSON files", progress: 66 });
  reporter?.({ type: "log", stream: "info", message: "Collecting parameter JSON files from enabled mods…" });
  const filesByParameter = await collectParameterJsonFiles(enabledMods);
  const parameterWarnings = await warnOnManagedParameterAssets(enabledMods, reporter);
  reporter?.({ type: "progress", step: "Combining parameter JSON files", progress: 67 });
  const { combined: combinedParameters, warnings: parameterMergeWarnings } =
    await combineParameterJsonFiles(filesByParameter, parameterPatchDir);
  for (const w of parameterMergeWarnings) {
    const message =
      `parameters/${w.shortName}.json row "${w.row}": ` +
      `higher-priority mod "${w.winner}" wins over ${w.overridden.map((m) => `"${m}"`).join(", ")}`;
    parameterWarnings.push(message);
    reporter?.({ type: "log", stream: "info", message: `Warning: ${message}` });
  }
  let patchedParameters = 0;
  let patchedParameterDetails = [];
  if (combinedParameters > 0) {
    const parameterOutputDir = path.join(stagingRoot, "Jujutsu Kaisen CC", "Content", "Widgets", "Commons");
    reporter?.({ type: "progress", step: "Patching cooked parameters", progress: 68 });
    reporter?.({ type: "log", stream: "info", message: `Patching cooked parameters → ${parameterOutputDir}` });
    await yieldToEventLoop();
    const patchResult = await patchCookedParameters(parameterPatchDir, parameterOutputDir, reporter);
    patchedParameters = patchResult.patched;
    patchedParameterDetails = patchResult.details;
  }
  if (patchedParameterDetails.length > 0) {
    const summaryLine = patchedParameterDetails
      .map((r) => `${r.shortName} (+${r.added}${r.replaced ? ` ~${r.replaced}` : ""}${r.skipped ? ` skip${r.skipped}` : ""})`)
      .join(", ");
    reporter?.({ type: "log", stream: "info", message: `Patched ${patchedParameters} cooked parameter asset(s): ${summaryLine}` });
  }

  // ── IoStore packaging ─────────────────────────────────────────────────────
  // Convert the entire staging tree into encrypted .utoc/.ucas containers.
  reporter?.({ type: "progress", step: "Building IoStore containers (retoc)", progress: 75 });
  reporter?.({ type: "log", stream: "info", message: "Running retoc to-zen…" });
  await runRetocToZen(stagingRoot, outputDir, ioBase, reporter);

  // Pack the AssetRegistry into a .pak so the game can read the asset index.
  reporter?.({ type: "progress", step: "Packing AssetRegistry (repak)", progress: 88 });
  reporter?.({ type: "log", stream: "info", message: "Running repak to pack AssetRegistry…" });
  await runRepakForRegistry(stagingRoot, outputDir, ioBase, enabledMods, reporter);

  // ── Deploy to game ────────────────────────────────────────────────────────
  // Every build step succeeded: install the generated package, prebuilt mod
  // packages and scripts/ plugins (higher priority wins on name clashes),
  // then remove manager-deployed files that are no longer needed.
  const { copiedPrebuiltPackages, copiedScripts } = await deployToGame(true);
  if (copiedPrebuiltPackages > 0) {
    reporter?.({ type: "log", stream: "info", message: `Copied ${copiedPrebuiltPackages} prebuilt package file(s)` });
  }
  if (copiedScripts > 0) {
    reporter?.({ type: "log", stream: "info", message: `Copied ${copiedScripts} scripts file(s)` });
  }

  reporter?.({ type: "progress", step: "Packaging complete", progress: 100 });
  reporter?.({ type: "log", stream: "info", message: `Done — ${enabledMods.length} mod(s) packaged, ${skipped} skipped` });

  return {
    outputDir,
    count: enabledMods.length,
    skipped,
    combinedTables,
    patchedTables,
    combinedParameters,
    patchedParameters,
    parameterWarnings,
    copiedAssetRoots,
    mergedRegistry,
    gamePaksModsDir,
    gameScriptsDir,
    copiedPrebuiltPackages,
    copiedScripts,
    utocPath: path.join(outputDir, `${ioBase}.utoc`),
    ucasPath: path.join(outputDir, `${ioBase}.ucas`),
    pakPath: path.join(outputDir, `${ioBase}.pak`),
  };
}

/**
 * Reads and parses a JSON file with better diagnostics for invalid JSON.
 * Also strips UTF-8 BOM (U+FEFF) so files saved with BOM still parse.
 *
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readJsonFileWithContext(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return parseJsonText(raw); // shared BOM-tolerant parse (lib/jsonUtils.js)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON file: ${filePath}\n${message}`);
  }
}

module.exports = {
  packageAllMods,
  collectDatatableJsonFiles,
  combineDatatableJsonFiles,
  mergeDatatableRows,
  collectParameterJsonFiles,
  combineParameterJsonFiles,
  patchCookedParameters,
  warnOnManagedParameterAssets,
  patchCookedDatatables,
  combineAssetRegistries,
  copyAssetsIntoStaging,
  runRetocToZen,
  copyPakAssetsIntoRegistryPak,
  runRepakForRegistry,
  ensureScriptsGlobalIni,
};
