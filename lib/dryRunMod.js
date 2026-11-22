/**
 * Patcher dry run for a single mod ("Check JSONs").
 *
 * Syntax/shape checks (validateModJson) can't tell whether the build will
 * accept a mod: unknown enum values, wrong value types, unknown parameter
 * files, … only surface when CookedDatatablePatcher / AssetRegistryPatcher
 * actually run. This runs the same per-file steps the build runs for one
 * mod — mergeDatatableRows → patchCookedDataTable against the bundled cooked
 * bases, patchBpParameter for parameters/, applyJsonToAssetRegistry for
 * AssetRegistry.json — writing patched output only into a temp directory
 * under os.tmpdir() that is removed afterwards. Nothing in the game folder
 * or the build output is touched.
 */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { yieldToEventLoop, existsAsync } = require("./asyncUtils");
const {
  APP_DIR,
  BASE_REGISTRY_BIN,
  DATATABLES_DIR,
  PARAMETERS_DIR,
  PARAMETERS_MANIFEST,
} = require("./constants");
const { registryIdentityKey } = require("./conflicts");
const {
  collectDatatableJsonFiles,
  mergeDatatableRows,
  resolveBundledUsmapPath,
  findFirstExisting,
  readJsonFileWithContext,
} = require("./packageAllMods");

const errorText = (err) => (err instanceof Error ? err.message : String(err));

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `abs` relative to the mod folder with forward slashes (validateModJson's `file`). */
function relTo(modPath, abs) {
  return path.relative(modPath, abs).split(path.sep).join("/");
}

async function loadModule(relCandidates) {
  const candidates = relCandidates.flatMap((rel) => [path.join(APP_DIR, rel), path.resolve(__dirname, "..", rel)]);
  const found = await findFirstExisting(candidates);
  return found ? import(pathToFileURL(found).href) : null;
}

async function topLevelJsonFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * @param {string} modPath  Absolute mod folder.
 * @param {{ skipFiles?: Set<string> }} opts  Mod-relative files that already
 *   failed syntax/shape checks (not patched again).
 * @returns {Promise<{ ran:boolean, note:string|null, errors:Array<{file,message}>, warnings:Array<{file,message}>, patched:{ datatables:number, parameters:number, registry:boolean } }>}
 */
async function dryRunMod(modPath, opts = {}) {
  // Compared case-insensitively: on Windows the folder may be "Datatables/".
  const skipLower = new Set([...(opts.skipFiles || [])].map((f) => String(f).toLowerCase()));
  const skip = { has: (f) => skipLower.has(String(f).toLowerCase()) };
  const errors = [];
  const warnings = [];
  const patched = { datatables: 0, parameters: 0, registry: false };
  const result = { ran: false, note: null, errors, warnings, patched };

  const patcher = await loadModule([path.join("CookedDatatablePatcher", "dist", "index.js")]);
  if (!patcher || !(await existsAsync(DATATABLES_DIR))) {
    result.note =
      "The patcher test could not run (cooked base tables or the CookedDatatablePatcher build are missing), so only JSON syntax and AssetRegistry shape were checked.";
    return result;
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jjkmm-dryrun-"));
  try {
    const usmapBuf = await fs.readFile(await resolveBundledUsmapPath());
    const registry = new patcher.SchemaRegistry(patcher.parseUsmap(usmapBuf));
    await yieldToEventLoop();

    // ── datatables/ ────────────────────────────────────────────────────────
    const cookedLower = new Map();
    for (const e of await fs.readdir(DATATABLES_DIR, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith(".uasset")) {
        const base = e.name.replace(/\.uasset$/i, "");
        cookedLower.set(base.toLowerCase(), base);
      }
    }
    const filesByTable = await collectDatatableJsonFiles([{ id: path.basename(modPath), fullPath: modPath, enabled: true }]);
    let n = 0;
    for (const [tableName, files] of filesByTable) {
      for (const abs of files) {
        const file = relTo(modPath, abs);
        if (skip.has(file)) continue;
        const cookedName = cookedLower.get(tableName.toLowerCase());
        if (!cookedName) {
          errors.push({
            file,
            message: `There is no game DataTable named "${tableName}" — the build fails with "Missing cooked base tables". Check the file name.`,
          });
          continue;
        }
        let rows;
        try {
          rows = await readJsonFileWithContext(abs);
        } catch {
          continue; // syntax errors are reported by validateModJson
        }
        if (!isPlainObject(rows)) continue;
        // Same merge step as the build (case-folded rows/fields), one contribution.
        const { combined } = mergeDatatableRows([{ source: path.basename(modPath), rows }]);
        const outDir = path.join(tmpRoot, "datatables", String(n++));
        await fs.mkdir(outDir, { recursive: true });
        const patchJsonPath = path.join(outDir, `${cookedName}.json`);
        await fs.writeFile(patchJsonPath, JSON.stringify(combined), "utf8");
        await yieldToEventLoop();
        try {
          const r = patcher.patchCookedDataTable({
            inputDir: DATATABLES_DIR,
            outputDir: outDir,
            tableAssetName: cookedName,
            patchJsonPath,
            addRows: true,
            registry,
          });
          patched.datatables += 1;
          // Not fatal for the build (the values are dropped / re-cased), so warnings.
          const unknown = (r.unknownFields ?? []).map((f) => `${f.path}.${f.patch}`);
          if (unknown.length > 0) {
            warnings.push({
              file,
              message: `${unknown.length} field(s) do not exist in ${cookedName} and are ignored by the build: ${unknown.join(", ")}`,
            });
          }
          const recased = (r.fieldCaseFixed ?? []).map((f) => `${f.path}.${f.patch} → ${f.canonical}`);
          if (recased.length > 0) {
            warnings.push({ file, message: `Field name capitalisation fixed by the build: ${recased.join(", ")}` });
          }
          if ((r.missingRows ?? []).length > 0) {
            warnings.push({ file, message: `Row(s) not found and skipped: ${r.missingRows.join(", ")}` });
          }
        } catch (err) {
          errors.push({ file, message: `The build would fail patching ${cookedName}: ${errorText(err)}` });
        }
        await fs.rm(outDir, { recursive: true, force: true });
        await yieldToEventLoop();
      }
    }

    // ── parameters/ ────────────────────────────────────────────────────────
    const paramFiles = (await topLevelJsonFiles(path.join(modPath, "parameters"))).filter((abs) => !skip.has(relTo(modPath, abs)));
    if (paramFiles.length > 0) {
      let baseOk = true;
      try {
        patcher.verifyBaseManifest(PARAMETERS_DIR, PARAMETERS_MANIFEST);
      } catch (err) {
        baseOk = false;
        result.note = `parameters/ were not test-patched: ${errorText(err)}`;
      }
      const canonicalByLower = new Map([...patcher.ASSET_BY_SHORT_NAME.keys()].map((k) => [k.toLowerCase(), k]));
      for (const abs of baseOk ? paramFiles : []) {
        const file = relTo(modPath, abs);
        const fileShort = path.basename(abs).replace(/\.json$/i, "");
        const shortName = canonicalByLower.get(fileShort.toLowerCase());
        if (!shortName) {
          errors.push({
            file,
            message: `Unknown parameter file; expected one of: ${[...patcher.ASSET_BY_SHORT_NAME.keys()].join(", ")}`,
          });
          continue;
        }
        let parsed;
        try {
          parsed = await readJsonFileWithContext(abs);
        } catch {
          continue;
        }
        if (!isPlainObject(parsed)) continue;
        const merged = {};
        for (const [row, value] of Object.entries(parsed)) {
          if (!row.startsWith("$")) merged[row] = value; // same as combineParameterJsonFiles
        }
        if (Object.keys(merged).length === 0) continue;
        const outDir = path.join(tmpRoot, "parameters", shortName);
        await fs.mkdir(outDir, { recursive: true });
        const patchJsonPath = path.join(outDir, `${shortName}.json`);
        await fs.writeFile(patchJsonPath, JSON.stringify(merged), "utf8");
        await yieldToEventLoop();
        try {
          patcher.patchBpParameter({ inputDir: PARAMETERS_DIR, outputDir: outDir, shortName, patchJsonPath, registry });
          patched.parameters += 1;
        } catch (err) {
          errors.push({ file, message: `The build would fail patching ${shortName}: ${errorText(err)}` });
        }
        await fs.rm(outDir, { recursive: true, force: true });
        await yieldToEventLoop();
      }
    }

    // ── AssetRegistry.json ─────────────────────────────────────────────────
    const regPath = path.join(modPath, "AssetRegistry.json");
    if (!skip.has("AssetRegistry.json") && (await existsAsync(regPath)) && (await existsAsync(BASE_REGISTRY_BIN))) {
      let parsed = null;
      try {
        parsed = await readJsonFileWithContext(regPath);
      } catch {
        parsed = null;
      }
      const generator = Array.isArray(parsed) ? await loadModule([path.join("AssetRegistryPatcher", "dist", "index.js")]) : null;
      if (generator) {
        // Same row selection as combineAssetRegistries (last entry per identity).
        const byKey = new Map();
        for (const entry of parsed) {
          if (typeof entry?.objectName !== "string" || !entry.objectName) continue;
          const key = registryIdentityKey(entry);
          if (key) byKey.set(key, entry);
        }
        if (byKey.size > 0) {
          const baseBuf = await fs.readFile(BASE_REGISTRY_BIN);
          await yieldToEventLoop();
          try {
            generator.applyJsonToAssetRegistry(baseBuf, [...byKey.values()]);
            patched.registry = true;
          } catch (err) {
            errors.push({ file: "AssetRegistry.json", message: `The build would fail merging the AssetRegistry: ${errorText(err)}` });
          }
          await yieldToEventLoop();
        }
      }
    }

    result.ran = true;
    return result;
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { dryRunMod };
