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
} = require("./constants");
const { retocPath, repakPath, runCommand } = require("./tools");
const { pathToFileURL } = require("url");
const { ensureDirectory, listModDirectoryNames, readModManifestJson, copyPackagedIoStoreToGamePaksMods, resolveGamePaksModsDir } = require("./modUtils");

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

// ─── Step 2 – Combine datatable JSON files into staging ───────────────────────

/**
 * For each datatable name collected in the previous step, reads all JSON files
 * that share that name (one per mod), concatenates their row arrays, and writes
 * a single combined JSON file directly into `outDir`.
 *
 * `outDir` is expected to be the game's `Content/DataTables/_ModManager` folder
 * (resolved from the game exe path by the orchestrator).  If `outDir` is null
 * (no game path configured) the step is skipped and 0 is returned.
 *
 * No external patching tool is invoked; row objects are merged with
 * `Object.assign` so that higher-priority mods overwrite conflicting row keys
 * from lower-priority mods.  The output is a single JSON object.
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
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
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

    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
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
  const generatorIndexPath = path.resolve(__dirname, "../AssetRegistryPatcher/dist/index.js");
  const { applyJsonToAssetRegistry } = await import(pathToFileURL(generatorIndexPath).href);

  const baseBuf = await fs.readFile(BASE_REGISTRY_BIN);
  const outBuf = applyJsonToAssetRegistry(baseBuf, registryRows);
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

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Main packaging pipeline.  Resolves all enabled mods, runs every step in
 * order, and returns a summary object.
 *
 * Pipeline steps (with approximate progress %):
 *   8  – Prepare output folders
 *  15  – Collect datatable JSON files from mod folders
 *  25  – Combine datatable JSON files → Content/DataTables/_ModManager
 *  42  – Merge AssetRegistry entries (AssetRegistryGenerator)
 *  58  – Copy loose mod assets into staging
 *  75  – Build IoStore containers (retoc to-zen)
 *  88  – Pack AssetRegistry (repak)
 *  93  – Copy main package to Content/Paks/~mods
 *  97  – Copy prebuilt mod packages to Content/Paks/~mods
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

  // Resolve and clear the ModManager datatable output directory.
  // Combined datatable JSON files are written here directly (not in staging).
  const gameDataTablesDir = gameExePath
    ? path.resolve(path.dirname(gameExePath), "../../Content/DataTables/_ModManager")
    : null;
  if (gameDataTablesDir) {
    reporter?.({ type: "progress", step: "Clearing Content/DataTables/ModManager", progress: 11 });
    await fs.rm(gameDataTablesDir, { recursive: true, force: true });
    await fs.mkdir(gameDataTablesDir, { recursive: true });
  }

  // Short-circuit when nothing is enabled: clean up and return empty result.
  if (enabledMods.length === 0) {
    reporter?.({ type: "progress", step: "No enabled mods to package", progress: 100 });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    return {
      outputDir,
      count: 0,
      skipped,
      combinedTables: 0,
      copiedAssetRoots: 0,
      mergedRegistry: null,
      gamePaksModsDir,
      copiedPrebuiltPackages: 0,
      utocPath: path.join(outputDir, `${ioBase}.utoc`),
      ucasPath: path.join(outputDir, `${ioBase}.ucas`),
      pakPath: path.join(outputDir, `${ioBase}.pak`),
    };
  }

  // Start with a clean staging directory on every run.
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  // ── Datatables ────────────────────────────────────────────────────────────
  // Collect all JSON files from mod `datatables/` folders, grouped by name.
  reporter?.({ type: "progress", step: "Collecting datatable JSON files", progress: 15 });
  reporter?.({ type: "log", stream: "info", message: "Collecting datatable JSON files from enabled mods…" });
  const filesByTable = await collectDatatableJsonFiles(enabledMods);

  // Merge same-named files into a single combined JSON written directly to the
  // game's Content/DataTables/ModManager folder (already cleared above).
  // No external tool is run; row objects are merged (higher priority wins).
  reporter?.({ type: "progress", step: "Combining datatable JSON files", progress: 25 });
  reporter?.({ type: "log", stream: "info", message: `Combining datatable JSON files → ${gameDataTablesDir ?? "(skipped, no game path)"}` });
  const combinedTables = await combineDatatableJsonFiles(filesByTable, gameDataTablesDir, reporter);
  if (combinedTables > 0) {
    reporter?.({ type: "log", stream: "info", message: `Combined ${combinedTables} datatable(s)` });
  }

  // ── Asset registry ────────────────────────────────────────────────────────
  // Merge each mod's AssetRegistry.json entries into one bin via AssetRegistryGenerator.
  reporter?.({ type: "progress", step: "Merging AssetRegistry entries", progress: 42 });
  reporter?.({ type: "log", stream: "info", message: "Merging AssetRegistry entries…" });
  const mergedRegistry = await combineAssetRegistries(enabledMods, stagingRoot, reporter);

  // ── Loose assets ─────────────────────────────────────────────────────────
  // Copy each mod's `assets/` folder contents into the staging tree.
  reporter?.({ type: "progress", step: "Copying mod assets into staging", progress: 58 });
  reporter?.({ type: "log", stream: "info", message: "Copying loose mod assets into staging…" });
  const copiedAssetRoots = await copyAssetsIntoStaging(enabledMods, stagingRoot);
  if (copiedAssetRoots > 0) {
    reporter?.({ type: "log", stream: "info", message: `Copied ${copiedAssetRoots} asset root(s)` });
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

  reporter?.({ type: "progress", step: "Packaging complete", progress: 100 });
  reporter?.({ type: "log", stream: "info", message: `Done — ${enabledMods.length} mod(s) packaged, ${skipped} skipped` });

  return {
    outputDir,
    count: enabledMods.length,
    skipped,
    combinedTables,
    copiedAssetRoots,
    mergedRegistry,
    gamePaksModsDir,
    copiedPrebuiltPackages,
    utocPath: path.join(outputDir, `${ioBase}.utoc`),
    ucasPath: path.join(outputDir, `${ioBase}.ucas`),
    pakPath: path.join(outputDir, `${ioBase}.pak`),
  };
}

module.exports = {
  packageAllMods,
  collectDatatableJsonFiles,
  combineDatatableJsonFiles,
  combineAssetRegistries,
  copyAssetsIntoStaging,
  runRetocToZen,
  copyPakAssetsIntoRegistryPak,
  runRepakForRegistry,
  copyModPrebuiltPackages,
};
