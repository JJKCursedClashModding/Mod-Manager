# Changelog

All notable changes to the JJK CC Mod Manager since `0.2.0`.

## [0.3.0] — 2026-10-01

Covers `0.2.0...0.3.0` (plus `db80703` CI follow-up on top).

### Mod distribution format: `.jjkmod`

- New mod package format `.jjkmod` (a zip with a `.jjkmod` extension). It must contain either a single top-level mod folder or a root-level `manifest.json`.
- **Add mod** picker now accepts both `.jjkmod` and `.zip` (`Mod packages` filter).
- **Package mod** changed from `(zip)` to `(.jjkmod)` — output is `<ModName>.jjkmod` via a new `packageSingleMod` implementation. The save dialog now asks where to save (default `mods/jjkmod/<Mod>.jjkmod`, extension auto-appended, overwrite allowed).
- Windows installer registers the `.jjkmod` file association (`JJK Mod Package`, app icon). Double-clicking a `.jjkmod` opens/focuses the app and installs it.
- Double-click delivery fixed with a `renderer-ready` handshake: main queues files from `argv` / `second-instance` / `open-file` and only sends `open-mod-file` after the renderer subscribes, so cold-start files are never lost in the `did-finish-load` race. Reloads also reset the ready flag.
- Install flow is confirm-first: renderer peeks the file (title/version without extracting) and shows *"Do you want to install TITLE (version)?"* with a **Currently installed** status line (new / update / same-version reinstall / older-than-installed) plus a static *"Only install mods from sources you trust"* note. Title rendering uses `textContent` (no path shown).
- Version-aware installs preserved: newer `manifest.json` versions replace older ones, otherwise the install is reported as up-to-date / unchanged.

### New: `parameters/*.json` pipeline for cooked Blueprint parameter mods

- Mods can now ship `parameters/*.json` — merged by filename, then patched into pristine cooked Blueprint assets instead of shipping whole conflicting `.uasset` files.
- Supported short names: `sceneCapture.json`, `character.json`, `storyDemo.json`, `exchangeImage.json`, `dynamicIcon.json` (mapped to the 5 `GameWidget*Parameter_BP` assets).
- Format is a datatables-style row dump of **new ID → complete literal row value** (`$`-prefixed keys are ignored as author annotations). Merging is priority-ascending per row key; same new key in several mods resolves by priority with a visible warning.
- Validation is strict: unknown struct fields / unknown image entries are build errors listing valid names; reusing an existing base-asset key is a build error (new characters must use new IDs).
- New baseline data: `data/parameters/` (10 pristine `.uasset`/`.uexp` pairs) + `data/parameters/base-manifest.json` (SHA-256 + size verification — a mismatch stops the build with a re-extract hint). Merged rows are staged at `Jujutsu Kaisen CC/Content/Widgets/Commons/`. Nothing is emitted when no enabled mod contributes rows.
- Shipping any of the 5 managed assets whole under `assets/` now logs a migration warning (merged output wins).
- Packaging performance: usmap is parsed once per datatable/parameter batch and shared via the patcher's shared-registry build; heavy sync chunks `yieldToEventLoop()` (`setImmediate`) so `package-progress` IPC flushes and the UI doesn't look hung. `CookedDatatablePatcher` submodule bumped accordingly.

### Overlap / conflict detection

- New `lib/conflicts.js`: scans only **enabled** mods against the same inputs the pipeline merges — same datatable row key, same parameter row key, same `assets/`/`pak_assets/` relative path, same `AssetRegistry.json` `objectName`, same prebuilt `*.pak/*.utoc/*.ucas` basename.
- Rules mirror the pipeline: highest `priority` wins, ties break alphabetically. Only file paths + row *keys* are read (never full asset bytes), one walk per mod, in-memory cache — toggling mods recomputes instantly with no disk I/O; refresh/install/folder-change rescans.
- UI: toolbar `⚠ N overlaps` button + per-mod `⚠ N overlaps` badges + **Overlapping files** modal showing each overlap and its winner. Result list capped at 400 (counts stay exact); scan warnings surfaced (max 10). Check is advisory and never breaks state loads.

### UI modernization + branding

- Full visual refresh (`renderer/styles.css`, `renderer/index.html`, `renderer/renderer.js`): dark theme, background glow, branded top bar with `logo.svg`, new `icon.png` / `icon.ico` / `favicon.png`, `scripts/generate-icons.cjs` icon generator, window icon + `#0c0e15` background, NSIS + exe branded with the multi-size ICO (16–256) for crisp taskbar/Explorer/title-bar rendering.
- Button renames: **Install Mods** → **Install enabled mods**, **Package mod (zip)** → **Package mod (.jjkmod)**. **Add mod** icon changed to plus.
- New library toolbar: search box (with clear button), `All / Enabled / Disabled` filter segmented control, `Sort: Priority ↓ / Name A–Z / Enabled first`, `0 / 0 enabled` count badge.
- Mod cards: icon thumbnails (or letter tiles), version + priority display, content checklist chips, per-mod overlap badges, per-mod footer **Tools (⋯)** menu — *Open folder*, *Create manifest.json* (new tool, never overwrites), *Package mod (.jjkmod)*. Footer Tools menu auto-flips below the trigger when room above is clipped.
- New toast system (`#toastRoot`, max 4 stacked, success/info/error variants) replacing most alerts.
- New modals: packaging progress console, **Overlapping files**, **Install mod?** confirmation, reworked Settings / Requirements cards, status bar (`mods folder` / `game linked` dots + *"higher priority wins"* hint), requirements-missing + app-update pills in the top bar.

### Mod metadata

- `manifest.json` now supports `title`, `description`, `version`, `priority`, `icon`. Priority default `0`, higher wins; UI lists highest-priority first.
- `icon`: image path relative to the mod folder (`.png/.jpg/.jpeg/.webp/.gif/.bmp/.svg/.ico`, max 512 KB, `../` escapes ignored). Resolved to a data URL with mtime-based caching; missing/invalid icons fall back to letter tiles.
- `version` shown in the library and used for update/unchanged decisions on `.jjkmod`/`.zip` installs (`compareVersions`, `peekModInfo`, `readVersionFromModFolder`).
- New **Create manifest.json** tool per mod (defaults `title=<folder>`, `version=1.0.0`, `priority=0`); skips when one already exists.
- Enabled-state storage migrated from legacy `disabledMods` blacklist to `enabledMods` whitelist (new mods default off); toggle-all helpers added.

### Fixes

- `.jjkmod` double-click race (handshake + queued delivery, focus/restore on delivery).
- Install prompt no longer shows file paths; uses safe text rendering; correctly reports new vs. update vs. up-to-date vs. newer-installed.
- `electron-builder 26` CI failure: dropped deprecated root `directories` key (kept `build.directories.output=dist`).

### CI / build / release

- New `beta-release.yml`: builds the Windows installer on PRs; on pushes to `main` / manual dispatch publishes a floating `beta` prerelease (installer + portable exe originally, now **NSIS setup only** per `db80703`). Filenames are stamped `*-beta-<UTC-date>-<sha>`; release notes carry commit + SmartScreen unsigned warning.
- CI reliability: Defender realtime scan disabled on `windows-latest` runners (fixes `EPERM rmdir` flakes), each project installs in its own step with `npm ci` (root `--ignore-scripts`, patchers with scripts for `prepare`/dist builds) so failures are isolated with full logs.
- `package.json`: version `0.2.0` → `0.3.0`; `files` now includes `scripts/**`; `win.icon` + `nsis.installerIcon/uninstallerIcon/installerHeaderIcon` + `fileAssociations[.jjkmod]` wired to `renderer/assets/icon.ico`; added `repository` / `bugs` / `homepage` metadata.
- README rewritten for all of the above: beta download badge/notice, **Install enabled mods** flow, `.jjkmod` section (format, association, portable-build caveat), `manifest.json` reference, **Overlaps** section, `parameters/*.json` reference (all 5 assets, row shapes, error cases, Urame example), 8-step packaging behavior, updated project layout.

### Commits since 0.2.0

`0ed9926` Modernize UI · `2b33c82` CI Defender fix · `b06a091` CI split installs · `ed0cef7` electron-builder 26 fix · `b6d7a42` parameters pipeline · `50a3dc1` CookedDataPatcher update · `485b739` NSIS/exe icon branding · `26ba3d6` responsive packaging UI · `0091d03` Add-mod plus icon · `3d43024` Package (.jjkmod) + Create manifest tool · `fde3af1` save-location dialog · `4087d09` Tools-menu flip · `6dc3018` .jjkmod association fix · `8ec2366` trust note + version status · `a0e7e05` inline TITLE (version) · `6736421` Bump to 0.3.0 · `db80703` NSIS-only CI.
