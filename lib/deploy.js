/**
 * Deploys build output into the game and tracks exactly which files the
 * manager put there.
 *
 * Why: the game folders the manager writes to — `Content/Paks/~mods` and
 * the Ultimate ASI Loader `scripts/` dir next to the exe — can also hold
 * files the user placed by hand (other paks, other ASI plugins). Older
 * versions wiped both folders at the start of every build, so a failed build
 * left the game with no mods and hand-placed files were lost.
 *
 * Now:
 * 1. The pipeline builds everything into staging first; deploy runs only
 *    after every build step succeeded.
 * 2. A deploy manifest (JSON, `deploy-manifest.json` in the build dir)
 *    records, per game target, every file the manager deployed (paths
 *    relative to ~mods / scripts/).
 * 3. Deploy copies the new files (temp file + rename, so a game never sees a
 *    half-written pak), then removes only previously-deployed files that are
 *    no longer needed. Files the manager didn't deploy are never deleted.
 * 4. If deploy fails partway, the error lists which files were updated,
 *    which failed, which were not reached and which stale files remain, and
 *    the manifest still lists every file that may be the manager's.
 */
const fs = require("fs/promises");
const path = require("path");
const { yieldToEventLoop, existsAsync } = require("./asyncUtils");

const DEPLOY_MANIFEST_FILE = "deploy-manifest.json";
const MANIFEST_VERSION = 1;
const PAK_EXTENSIONS = new Set([".pak", ".utoc", ".ucas"]);

const caseFold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
const relKey = (rel) => caseFold(rel.replace(/\\/g, "/"));

async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves `rel` under `root`, refusing anything that escapes it. */
function resolveInside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs === base || !abs.startsWith(base + path.sep)) {
    return null;
  }
  return abs;
}

// ─── Planning ────────────────────────────────────────────────────────────────

/**
 * Root-level prebuilt packages (.pak/.utoc/.ucas) of the enabled mods.
 *
 * - A file set named like the generated package (zModLoader_P.*) would
 *   overwrite the manager's own output → the build fails before deploying.
 * - An IoStore set (.utoc/.ucas) must be complete (.pak + .utoc + .ucas);
 *   incomplete sets can't mount and are skipped with a warning. A lone .pak
 *   is a legitimate legacy pak and is deployed.
 * - Names are kept as shipped (UE orders paks by name / _P suffix and mod
 *   authors pick names deliberately). Same-named files from several mods:
 *   the higher-priority mod wins (mods arrive priority-ascending), with a
 *   warning; conflicts.js flags these in the overlap view too.
 *
 * @returns {Promise<{ files: Array<{src:string, rel:string, modId:string}>, warnings: string[] }>}
 */
async function collectPrebuiltPackages(enabledMods, generatedBase) {
  const warnings = [];
  const collisions = [];
  const byName = new Map();
  for (const mod of enabledMods) {
    if (!mod.enabled) continue;
    let entries;
    try {
      entries = await fs.readdir(mod.fullPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const sets = new Map(); // lower base → { base, files: Map<ext, name> }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!PAK_EXTENSIONS.has(ext)) continue;
      const base = entry.name.slice(0, -ext.length);
      const key = base.toLowerCase();
      if (!sets.has(key)) sets.set(key, { base, files: new Map() });
      sets.get(key).files.set(ext, entry.name);
    }
    for (const [key, set] of sets) {
      if (key === generatedBase.toLowerCase()) {
        collisions.push(`${mod.id}: ${[...set.files.values()].join(", ")}`);
        continue;
      }
      const hasIoStore = set.files.has(".utoc") || set.files.has(".ucas");
      const complete = set.files.has(".pak") && set.files.has(".utoc") && set.files.has(".ucas");
      if (hasIoStore && !complete) {
        const missing = [".pak", ".utoc", ".ucas"].filter((e) => !set.files.has(e)).map((e) => `${set.base}${e}`);
        warnings.push(`${mod.id}: prebuilt package ${set.base} is incomplete (missing ${missing.join(", ")}) and was not installed`);
        continue;
      }
      for (const name of set.files.values()) {
        const k = relKey(name);
        const previous = byName.get(k);
        if (previous && previous.modId !== mod.id) {
          warnings.push(`prebuilt ${name}: higher-priority mod "${mod.id}" overwrites "${previous.modId}"`);
        }
        byName.set(k, { src: path.join(mod.fullPath, name), rel: name, modId: mod.id });
      }
    }
    await yieldToEventLoop();
  }
  if (collisions.length > 0) {
    throw new Error(
      `These mods ship prebuilt packages named like the manager's generated package (${generatedBase}.*), ` +
        `which would overwrite it. Rename the files in the mod folder:\n${collisions.join("\n")}`,
    );
  }
  return { files: [...byName.values()], warnings };
}

/**
 * Every file of each enabled mod's `scripts/` folder, relative to it.
 * Higher priority wins on the same relative path. A mod's root
 * `scripts/global.ini` is not deployed: the game's global.ini is the
 * user's / manager's (see ensureScriptsGlobalIni) and must not be replaced
 * or later removed.
 *
 * @returns {Promise<{ files: Array<{src:string, rel:string, modId:string}>, warnings: string[] }>}
 */
async function collectScripts(enabledMods) {
  const warnings = [];
  const byRel = new Map();
  for (const mod of enabledMods) {
    if (!mod.enabled) continue;
    const scriptsDir = path.join(mod.fullPath, "scripts");
    if (!(await isDirectory(scriptsDir))) continue;
    const stack = [""];
    let n = 0;
    while (stack.length > 0) {
      const rel = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(rel ? path.join(scriptsDir, rel) : scriptsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          stack.push(childRel);
        } else if (entry.isFile()) {
          if (relKey(childRel) === "global.ini") {
            warnings.push(`${mod.id}: scripts/global.ini is not installed (the game's global.ini is left as-is)`);
            continue;
          }
          byRel.set(relKey(childRel), { src: path.join(scriptsDir, childRel), rel: childRel, modId: mod.id });
          if (++n % 50 === 0) await yieldToEventLoop();
        }
      }
    }
    await yieldToEventLoop();
  }
  return { files: [...byRel.values()], warnings };
}

/**
 * Builds the full list of files to deploy. Must be called after the build
 * succeeded (it does no writes).
 *
 * @param {{ enabledMods: Array, outputDir: string, ioBase: string, includeGenerated: boolean }} opts
 * @returns {Promise<{ paks: Array<{src,rel}>, scripts: Array<{src,rel}>, warnings: string[] }>}
 */
async function planDeployment({ enabledMods, outputDir, ioBase, includeGenerated }) {
  const paks = [];
  if (includeGenerated) {
    for (const ext of [".pak", ".utoc", ".ucas"]) {
      const src = path.join(outputDir, `${ioBase}${ext}`);
      if (!(await existsAsync(src))) {
        throw new Error(`Expected output file missing after packaging: ${src}`);
      }
      paks.push({ src, rel: `${ioBase}${ext}`, modId: null });
    }
  }
  const prebuilt = await collectPrebuiltPackages(enabledMods, ioBase);
  paks.push(...prebuilt.files);
  const scripts = await collectScripts(enabledMods);
  return { paks, scripts: scripts.files, warnings: [...prebuilt.warnings, ...scripts.warnings] };
}

// ─── Manifest ────────────────────────────────────────────────────────────────

function targetKey(paksDir, scriptsDir) {
  return caseFold(`${paksDir ? path.resolve(paksDir) : ""}|${scriptsDir ? path.resolve(scriptsDir) : ""}`);
}

async function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse((await fs.readFile(manifestPath, "utf8")).replace(/^﻿/, ""));
    if (parsed && typeof parsed === "object" && parsed.targets && typeof parsed.targets === "object") {
      return { manifest: parsed, corrupt: false };
    }
    return { manifest: { version: MANIFEST_VERSION, targets: {} }, corrupt: true };
  } catch (error) {
    return { manifest: { version: MANIFEST_VERSION, targets: {} }, corrupt: !(error && error.code === "ENOENT") };
  }
}

async function writeManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await fs.rename(tmp, manifestPath);
}

function uniqueRels(list) {
  const map = new Map();
  for (const rel of list) {
    if (typeof rel === "string" && rel) map.set(relKey(rel), rel);
  }
  return [...map.values()];
}

function minus(list, remove) {
  const drop = new Set(remove.map(relKey));
  return list.filter((rel) => !drop.has(relKey(rel)));
}

// ─── First-run migration ─────────────────────────────────────────────────────

const FULL_COMPARE_BYTES = 8 * 1024 * 1024;
const EDGE_COMPARE_BYTES = 1024 * 1024;

async function readRange(file, start, length) {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Cheap "is this the same file" check: equal size, and equal bytes (whole
 * file up to 8 MB, otherwise the first and last 1 MB).
 */
async function filesLookIdentical(a, b) {
  let sa;
  let sb;
  try {
    [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  } catch {
    return false;
  }
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  try {
    if (sa.size <= FULL_COMPARE_BYTES) {
      const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
      return ba.equals(bb);
    }
    const tail = sa.size - EDGE_COMPARE_BYTES;
    const [ha, hb, ta, tb] = await Promise.all([
      readRange(a, 0, EDGE_COMPARE_BYTES),
      readRange(b, 0, EDGE_COMPARE_BYTES),
      readRange(a, tail, EDGE_COMPARE_BYTES),
      readRange(b, tail, EDGE_COMPARE_BYTES),
    ]);
    return ha.equals(hb) && ta.equals(tb);
  } catch {
    return false;
  }
}

/**
 * First run with no deploy manifest (upgrading from a version that wiped
 * the folders): we don't know what the manager deployed before, so be
 * conservative. Treated as previously deployed — and thus removable when no
 * longer needed — are only:
 * - the generated package triple (zModLoader_P.pak/.utoc/.ucas), which only
 *   the manager writes;
 * - files in ~mods / scripts/ that are byte-identical copies of a library
 *   mod's prebuilt package or scripts/ file (enabled or disabled mods, so
 *   disabling everything also clears a disabled mod's old copies).
 * Everything else is unknown and left alone.
 */
async function migrationDeployedSet({ libraryMods, paksDir, scriptsDir, ioBase }) {
  const paks = [];
  const scripts = [];
  if (paksDir) {
    for (const ext of [".pak", ".utoc", ".ucas"]) {
      if (await existsAsync(path.join(paksDir, `${ioBase}${ext}`))) paks.push(`${ioBase}${ext}`);
    }
  }
  const asEnabled = libraryMods.map((m) => ({ ...m, enabled: true }));
  if (paksDir) {
    // Collisions with the generated name are irrelevant here; scan each mod's
    // root directly so a bad mod can't abort the migration.
    for (const mod of asEnabled) {
      let entries;
      try {
        entries = await fs.readdir(mod.fullPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !PAK_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const dest = resolveInside(paksDir, entry.name);
        if (dest && (await filesLookIdentical(path.join(mod.fullPath, entry.name), dest))) paks.push(entry.name);
      }
      await yieldToEventLoop();
    }
  }
  if (scriptsDir) {
    const { files } = await collectScripts(asEnabled);
    for (const f of files) {
      const dest = resolveInside(scriptsDir, f.rel);
      if (dest && (await filesLookIdentical(f.src, dest))) scripts.push(f.rel);
    }
  }
  return { paks: uniqueRels(paks), scripts: uniqueRels(scripts) };
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

async function copyAtomic(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.jjkmm-tmp`;
  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Removes now-empty directories between `dir` and `root` (exclusive). */
async function pruneEmptyDirs(root, dir) {
  const base = path.resolve(root);
  let current = path.resolve(dir);
  while (current !== base && current.startsWith(base + path.sep)) {
    try {
      await fs.rmdir(current); // fails (ENOTEMPTY) when anything remains
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function describeError(error) {
  const code = error && error.code ? ` [${error.code}]` : "";
  const hint = error && ["EBUSY", "EPERM", "EACCES"].includes(error.code) ? " (is the game running?)" : "";
  return `${error instanceof Error ? error.message : String(error)}${code}${hint}`;
}

/**
 * Copies the planned files into the game, then removes previously deployed
 * files that are no longer planned. Never touches files it didn't deploy.
 *
 * @param {object} opts
 * @param {{paks:Array<{src,rel}>, scripts:Array<{src,rel}>}} opts.plan
 * @param {string|null} opts.paksDir      Content/Paks/~mods
 * @param {string|null} opts.scriptsDir   game scripts/
 * @param {string} opts.manifestPath      deploy manifest file
 * @param {Array<{id,fullPath}>} opts.libraryMods  All library mods (migration)
 * @param {string} opts.ioBase            generated package base name
 * @param {Function|null} [opts.reporter]
 * @returns {Promise<{ copiedPaks:number, copiedScripts:number, removed:string[], migrated:boolean }>}
 */
async function deployPlannedFiles({ plan, paksDir, scriptsDir, manifestPath, libraryMods, ioBase, reporter = null }) {
  const log = (message, stream = "info") => reporter?.({ type: "log", stream, message });
  const key = targetKey(paksDir, scriptsDir);
  const { manifest, corrupt } = await readManifest(manifestPath);
  if (corrupt) {
    log(`Deploy manifest at ${manifestPath} was unreadable; treating this as a first run.`, "warn");
  }
  let previous = manifest.targets[key];
  const migrated = !previous;
  if (!previous) {
    previous = await migrationDeployedSet({ libraryMods, paksDir, scriptsDir, ioBase });
    log(
      `No deploy manifest for this game yet: treating ${previous.paks.length + previous.scripts.length} known ` +
        `manager file(s) as previously installed; other files in ~mods and scripts/ are left alone.`,
    );
  }
  const prevPaks = uniqueRels(previous.paks || []);
  const prevScripts = uniqueRels(previous.scripts || []);
  const newPaks = paksDir ? uniqueRels(plan.paks.map((f) => f.rel)) : [];
  const newScripts = scriptsDir ? uniqueRels(plan.scripts.map((f) => f.rel)) : [];

  const saveTarget = async (paks, scripts) => {
    manifest.version = MANIFEST_VERSION;
    manifest.targets[key] = {
      paksModsDir: paksDir,
      scriptsDir,
      paks: uniqueRels(paks),
      scripts: uniqueRels(scripts),
      updatedAt: new Date().toISOString(),
    };
    await writeManifest(manifestPath, manifest);
  };

  // Before touching the game: record everything that may be ours after this
  // run (old ∪ new), so a crash mid-deploy never orphans manager files.
  await saveTarget([...prevPaks, ...newPaks], [...prevScripts, ...newScripts]);

  const jobs = [
    ...(paksDir ? plan.paks.map((f) => ({ ...f, root: paksDir, label: `~mods/${f.rel}` })) : []),
    ...(scriptsDir ? plan.scripts.map((f) => ({ ...f, root: scriptsDir, label: `scripts/${f.rel}` })) : []),
  ];
  const done = [];
  let copiedPaks = 0;
  let copiedScripts = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const dest = resolveInside(job.root, job.rel);
    try {
      if (!dest) throw new Error(`unsafe destination path ${job.rel}`);
      await copyAtomic(job.src, dest);
    } catch (error) {
      const notReached = jobs.slice(i + 1).map((j) => j.label);
      const staleP = minus(prevPaks, newPaks).map((r) => `~mods/${r}`);
      const staleS = minus(prevScripts, newScripts).map((r) => `scripts/${r}`);
      const list = (items) => (items.length ? items.map((x) => `  - ${x}`).join("\n") : "  (none)");
      throw new Error(
        `Deploying to the game failed at ${job.label}: ${describeError(error)}\n` +
          `Updated to the new build (${done.length}):\n${list(done)}\n` +
          `Failed (left as it was before this run):\n  - ${job.label}\n` +
          `Not reached (left as it was before this run) (${notReached.length}):\n${list(notReached)}\n` +
          `Old manager files not removed yet (${staleP.length + staleS.length}):\n${list([...staleP, ...staleS])}\n` +
          `No other files were touched. Fix the problem and run the install again to finish.`,
      );
    }
    done.push(job.label);
    if (job.root === paksDir) copiedPaks += 1;
    else copiedScripts += 1;
    reporter?.({ type: "log", stream: "stdout", message: `Copied ${job.label}` });
    if ((i + 1) % 20 === 0) await yieldToEventLoop();
  }

  // Remove previously deployed files that this build no longer installs.
  const removed = [];
  const failedRemovals = { paks: [], scripts: [] };
  const removeStale = async (root, rels, bucket, prefix) => {
    if (!root) return;
    for (const rel of rels) {
      const abs = resolveInside(root, rel);
      if (!abs) continue; // tampered manifest entry → never delete outside
      try {
        await fs.rm(abs, { force: true });
        removed.push(`${prefix}${rel}`);
        await pruneEmptyDirs(root, path.dirname(abs));
      } catch (error) {
        failedRemovals[bucket].push(rel);
        log(`Could not remove old ${prefix}${rel}: ${describeError(error)}`, "error");
      }
    }
  };
  await removeStale(paksDir, minus(prevPaks, newPaks), "paks", "~mods/");
  await removeStale(scriptsDir, minus(prevScripts, newScripts), "scripts", "scripts/");
  for (const r of removed) log(`Removed ${r} (no longer installed by any enabled mod)`);

  await saveTarget([...newPaks, ...failedRemovals.paks], [...newScripts, ...failedRemovals.scripts]);
  if (failedRemovals.paks.length + failedRemovals.scripts.length > 0) {
    throw new Error(
      `The new build was installed, but some old manager files could not be removed ` +
        `(they are still tracked and will be retried next time):\n` +
        [...failedRemovals.paks.map((r) => `~mods/${r}`), ...failedRemovals.scripts.map((r) => `scripts/${r}`)]
          .map((x) => `  - ${x}`)
          .join("\n"),
    );
  }
  return { copiedPaks, copiedScripts, removed, migrated };
}

module.exports = {
  DEPLOY_MANIFEST_FILE,
  planDeployment,
  deployPlannedFiles,
  collectPrebuiltPackages,
  collectScripts,
  migrationDeployedSet,
  filesLookIdentical,
};
