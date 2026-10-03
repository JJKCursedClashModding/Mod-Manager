const fs = require("fs/promises");
const path = require("path");
const { existsSync } = require("fs");
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
const { retocPath, repakPath, runCommand } = require("./tools");
const { pathToFileURL } = require("url");
const { ensureDirectory, listModDirectoryNames, readModManifestJson, copyPackagedIoStoreToGamePaksMods, resolveGamePaksModsDir, resolveGameScriptsDir } = require("./modUtils");

/**
 * Lets Electron's main event loop breathe between heavy synchronous chunks.
 * `async` alone doesn't unblock anything: the datatable/parameter/registry
 * patchers are CPU-bound sync code, so without an explicit yield the queued
 * `package-progress` IPC messages can't flush and the UI looks hung.
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function resolveBundledUsmapPath() {
  const candidates = [
    path.join(APP_DIR, "CookedDatatablePatcher", "mappings.usmap"),
    path.resolve(__dirname, "../CookedDatatablePatcher/mappings.usmap"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

// ─── Step 1 – Collect datatable JSON files ────────────────────────────────────

/**
 * Walks every enabled mod's `datatables/` folder and groups all JSON files by
 * their base filename (e.g. "AttackSetDataTable").  Files with the same base
 * name across multiple mods will be merged together in the next step.
 *
 * @param {Array} mods  Enabled mod objects (must have `.fullPath` and `.enabled`).
 * @returns {Map<string, string[]>}  tableName → [absoluteFilePath, …]
 */
async function collectDatatableJsonFiles(mods) {
  const filesByTable = new Map();

  for (const mod of mods) {
    if (!mod.enabled) continue;

    const datatableDir = path.join(mod.fullPath, "datatables");
    if (!(await ensureDirectory(datatableDir))) continue;

    const entries = await fs.readdir(datatableDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;

      const abs = path.join(datatableDir, entry.name);
      const tableName = path.parse(entry.name).name;

      if (!filesByTable.has(tableName)) filesByTable.set(tableName, []);
      filesByTable.get(tableName).push(abs);
    }
  }

  return filesByTable;
}

// ─── Step 2 – Combine datatable JSON files into a temp patch dir ───────────────

/**
 * For each datatable name collected in the previous step, reads all JSON files
 * that share that name (one per mod), merges row objects, and writes a single
 * combined JSON file into `outDir` (a temp folder used as CookedDatatablePatcher
 * input).  If `outDir` is null the step is skipped and 0 is returned.
 *
 * Row objects are merged with `Object.assign` so that higher-priority mods
 * overwrite conflicting row keys from lower-priority mods.
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
    // Read every contributing file and merge into a single object.
    // Files are provided in priority-ascending order (lowest first), so
    // Object.assign naturally lets higher-priority mods overwrite conflicting
    // row keys from lower-priority mods.
    const combined = {};
    for (const filePath of filePaths) {
      const parsed = await readJsonFileWithContext(filePath);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(combined, parsed);
      }
    }

    const outPath = path.join(outDir, `${tableName}.json`);
    await fs.writeFile(outPath, JSON.stringify(combined, null, 2), "utf8");

    combinedCount += 1;
  }

  return combinedCount;
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

  for (const mod of mods) {
    if (!mod.enabled) continue;

    const parametersDir = path.join(mod.fullPath, "parameters");
    if (!(await ensureDirectory(parametersDir))) continue;

    const entries = await fs.readdir(parametersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;

      const shortName = path.parse(entry.name).name;
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
async function patchCookedParameters(parametersDir, outputDir, reporter = null) {
  if (!existsSync(PARAMETERS_DIR)) {
    throw new Error(`Missing cooked parameter bases directory at ${PARAMETERS_DIR}`);
  }

  const patcherCandidates = [
    path.join(APP_DIR, "CookedDatatablePatcher", "dist", "index.js"),
    path.resolve(__dirname, "../CookedDatatablePatcher/dist/index.js"),
  ];
  const patcherPath = patcherCandidates.find((candidate) => existsSync(candidate));
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
  const usmapBuf = await fs.readFile(resolveBundledUsmapPath());
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
  for (let i = 0; i < shorts.length; i++) {
    const shortName = shorts[i];
    if (!ASSET_BY_SHORT_NAME.has(shortName)) {
      const valid = [...ASSET_BY_SHORT_NAME.keys()].join(", ");
      errors.push({ shortName, error: `unknown parameter file; expected one of: ${valid}` });
      continue;
    }
    const patchPath = path.join(parametersDir, `${shortName}.json`);
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
  if (!existsSync(DATATABLES_DIR)) {
    throw new Error(`Missing cooked datatables directory at ${DATATABLES_DIR}`);
  }

  const patcherCandidates = [
    path.join(APP_DIR, "CookedDatatablePatcher", "dist", "index.js"),
    path.resolve(__dirname, "../CookedDatatablePatcher/dist/index.js"),
  ];
  const patcherIndexPath = patcherCandidates.find((candidate) => existsSync(candidate));
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
  const usmapBuf = await fs.readFile(resolveBundledUsmapPath());
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
  // Gather every mod's AssetRegistry entries, deduplicating by objectName.
  // Mods are processed in priority-ascending order so later (higher-priority)
  // entries overwrite earlier ones for the same objectName.
  const registryByPath = new Map();
  for (const mod of enabledMods) {
    if (!mod.enabled) continue;

    const manifestPath = path.join(mod.fullPath, "AssetRegistry.json");
    if (!existsSync(manifestPath)) continue;

    const parsed = await readJsonFileWithContext(manifestPath);
    if (!Array.isArray(parsed)) {
      throw new Error(`AssetRegistry.json must be an array in ${manifestPath}`);
    }
    for (const entry of parsed) {
      const key = entry?.objectName;
      if (typeof key === "string" && key) {
        registryByPath.set(key, entry);
      }
    }
  }

  const registryRows = [...registryByPath.values()];

  if (!existsSync(BASE_REGISTRY_BIN)) {
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
  const generatorIndexPath = generatorCandidates.find((candidate) => existsSync(candidate));
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
  await runCommand(
    retocPath(),
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
  await runCommand(
    repakPath(),
    ["pack", tempRegistryPackDir, pakPath, "--version", REPAK_VERSION, "--mount-point", REPAK_MOUNT_POINT],
    APP_DIR,
    { reporter },
  );
}

// ─── Step 7 – Copy prebuilt mod packages to the destination ──────────────────

/**
 * Some mods ship as pre-packaged IoStore containers (.pak / .utoc / .ucas)
 * instead of loose assets.  This step scans the root of each enabled mod folder
 * for those files and copies them directly into `destDir` alongside the
 * mod-manager-generated package.
 *
 * Files are only copied when `destDir` is provided (i.e. when a game path is
 * configured); otherwise this step is silently skipped.
 *
 * @param {Array}        enabledMods  Enabled mod objects with `.fullPath`.
 * @param {string|null}  destDir      Destination directory (Content/Paks/~mods).
 * @param {Function|null} reporter
 * @returns {number}  Number of individual files copied.
 */
async function copyModPrebuiltPackages(enabledMods, destDir, reporter = null) {
  if (!destDir) {
    return 0;
  }

  await fs.mkdir(destDir, { recursive: true });

  const PAK_EXTENSIONS = new Set([".pak", ".utoc", ".ucas"]);
  let copiedCount = 0;

  for (const mod of enabledMods) {
    if (!mod.enabled) continue;

    const entries = await fs.readdir(mod.fullPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!PAK_EXTENSIONS.has(ext)) continue;

      const src = path.join(mod.fullPath, entry.name);
      const dest = path.join(destDir, entry.name);
      await fs.copyFile(src, dest);
      copiedCount += 1;
    }
  }

  return copiedCount;
}

// ─── Step 7b – Deploy Ultimate ASI Loader plugins (scripts/) ──────────────────

/**
 * Default `global.ini` written into the game `scripts/` dir when none exists.
 * Enables recursive plugin loading so per-mod subfolders work on UAL builds
 * that support it; harmless on builds that only load flat files.
 */
const SCRIPTS_GLOBAL_INI = `[GlobalSets]\nLoadPlugins=1\nLoadRecursively=1\n`;

/**
 * Ensures the game `scripts/` dir exists and has a `global.ini`.
 * An existing user-customized `global.ini` is never overwritten.
 */
async function ensureScriptsGlobalIni(scriptsDir, reporter = null) {
  if (!scriptsDir) return;
  await fs.mkdir(scriptsDir, { recursive: true });
  const iniPath = path.join(scriptsDir, "global.ini");
  if (!existsSync(iniPath)) {
    await fs.writeFile(iniPath, SCRIPTS_GLOBAL_INI, "utf8");
    reporter?.({ type: "log", stream: "info", message: "Created scripts/global.ini (LoadRecursively=1)" });
  }
}

/**
 * Clears stale manager-deployed files from the game `scripts/` dir.
 * Preserves a pre-existing `global.ini` (user customization) across the wipe.
 */
async function clearGameScriptsDir(scriptsDir, reporter = null) {
  if (!scriptsDir) return;
  let preservedIni = null;
  const iniPath = path.join(scriptsDir, "global.ini");
  try {
    if (existsSync(iniPath)) preservedIni = await fs.readFile(iniPath);
  } catch { preservedIni = null; }
  await fs.rm(scriptsDir, { recursive: true, force: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  if (preservedIni !== null) {
    await fs.writeFile(iniPath, preservedIni);
  }
}

/**
 * Copies each enabled mod's `scripts/` folder (ASI/DLL plugins + sidecars)
 * into the game `scripts/` dir next to the exe, preserving relative paths.
 * Mods are processed lowest-priority-first so higher-priority mods overwrite
 * on conflict (mirrors assets/pak_assets semantics). Symlinks are skipped.
 *
 * @returns {number} Number of files copied.
 */
async function copyScriptsIntoGameScripts(enabledMods, destDir, reporter = null) {
  if (!destDir) return 0;
  await fs.mkdir(destDir, { recursive: true });
  let copiedCount = 0;
  for (const mod of enabledMods) {
    if (!mod.enabled) continue;
    const scriptsDir = path.join(mod.fullPath, "scripts");
    if (!(await ensureDirectory(scriptsDir))) continue;
    const stack = [""];
    while (stack.length > 0) {
      const rel = stack.pop();
      const abs = rel ? path.join(scriptsDir, rel) : scriptsDir;
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const src = path.join(scriptsDir, childRel);
        const dest = path.join(destDir, childRel);
        if (entry.isDirectory()) {
          stack.push(childRel);
        } else if (entry.isFile()) {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(src, dest);
          copiedCount += 1;
        }
      }
    }
  }
  return copiedCount;
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
 *  93  – Copy main package to Content/Paks/~mods
 *  97  – Copy prebuilt mod packages to Content/Paks/~mods
 *  98  – Copy scripts/ ASI plugins to game scripts/ (Ultimate ASI Loader)
 * 100  – Done
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

  const ioBase = "zModLoader_P";
  const stagingRoot = path.join(BUILD_DIR, "staging");
  const outputDir = path.join(BUILD_DIR, "output");
  const datatablePatchDir = path.join(BUILD_DIR, "datatable-patches");
  const parameterPatchDir = path.join(BUILD_DIR, "parameter-patches");

  reporter?.({ type: "progress", step: "Preparing output folders", progress: 8 });
  await fs.mkdir(outputDir, { recursive: true });

  // Clear the ~mods destination directory at the start of every run so stale
  // files from a previous packaging don't linger alongside the new output.
  // This is done unconditionally (even when no mods are enabled) so the folder
  // always reflects the current run's results.
  const gamePaksModsDir = resolveGamePaksModsDir(gameExePath);
  if (gamePaksModsDir) {
    reporter?.({ type: "progress", step: "Clearing Content/Paks/~mods", progress: 10 });
    await fs.rm(gamePaksModsDir, { recursive: true, force: true });
    await fs.mkdir(gamePaksModsDir, { recursive: true });
  }

  // Clear the game scripts/ dir (Ultimate ASI Loader plugins) so disabled or
  // removed mods don't leave stale ASI/DLLs behind. Runs unconditionally so
  // the folder always reflects the current enabled set. A pre-existing
  // global.ini is preserved across the wipe (see clearGameScriptsDir).
  const gameScriptsDir = resolveGameScriptsDir(gameExePath);
  if (gameScriptsDir) {
    reporter?.({ type: "progress", step: "Clearing game scripts/", progress: 10 });
    await clearGameScriptsDir(gameScriptsDir, reporter);
  }

  // Clear stale runtime JSON datatable folder from older mod-manager versions.
  // Patched cooked tables now ship inside the IoStore package instead.
  const staleModManagerDir = gameExePath
    ? path.resolve(path.dirname(gameExePath), "../../Content/DataTables/_ModManager")
    : null;
  if (staleModManagerDir) {
    reporter?.({ type: "progress", step: "Clearing stale Content/DataTables/_ModManager", progress: 11 });
    await fs.rm(staleModManagerDir, { recursive: true, force: true });
  }

  // Short-circuit when nothing is enabled: clean up and return empty result.
  // game scripts/ was already cleared above; leave a global.ini so UAL keeps
  // recursive loading enabled for the next install.
  if (enabledMods.length === 0) {
    reporter?.({ type: "progress", step: "No enabled mods to package", progress: 100 });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(datatablePatchDir, { recursive: true, force: true });
    await fs.rm(parameterPatchDir, { recursive: true, force: true });
    await ensureScriptsGlobalIni(gameScriptsDir, reporter);
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
  // Copy the mod-manager-generated package (.pak + .utoc + .ucas) to ~mods.
  // gamePaksModsDir was already resolved and cleared at the top of this function.
  reporter?.({ type: "progress", step: "Copying generated package to Content/Paks/~mods", progress: 93 });
  reporter?.({ type: "log", stream: "info", message: `Copying generated package to ${gamePaksModsDir ?? "(skipped, no game path)"}…` });
  await copyPackagedIoStoreToGamePaksMods(gameExePath, outputDir, ioBase, reporter);

  // Copy any prebuilt packages (.pak/.utoc/.ucas) found in mod root folders to
  // the same ~mods destination so they are all loaded together by the game.
  reporter?.({ type: "progress", step: "Copying prebuilt mod packages to Content/Paks/~mods", progress: 97 });
  reporter?.({ type: "log", stream: "info", message: "Copying prebuilt mod packages…" });
  const copiedPrebuiltPackages = await copyModPrebuiltPackages(enabledMods, gamePaksModsDir, reporter);
  if (copiedPrebuiltPackages > 0) {
    reporter?.({ type: "log", stream: "info", message: `Copied ${copiedPrebuiltPackages} prebuilt package file(s)` });
  }

  // Deploy ASI/DLL plugins from each enabled mod's scripts/ folder into the
  // game scripts/ dir (already cleared above). Higher priority wins on conflict.
  reporter?.({ type: "progress", step: "Copying ASI scripts to game scripts/", progress: 98 });
  reporter?.({ type: "log", stream: "info", message: "Copying scripts/ plugins…" });
  const copiedScripts = await copyScriptsIntoGameScripts(enabledMods, gameScriptsDir, reporter);
  await ensureScriptsGlobalIni(gameScriptsDir, reporter);
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
  const text = raw.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON file: ${filePath}\n${message}`);
  }
}

module.exports = {
  packageAllMods,
  collectDatatableJsonFiles,
  combineDatatableJsonFiles,
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
  copyModPrebuiltPackages,
  copyScriptsIntoGameScripts,
  ensureScriptsGlobalIni,
  clearGameScriptsDir,
};
