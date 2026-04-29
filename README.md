# JJK CC Mod Manager

Electron desktop app for managing and installing mods for **Jujutsu Kaisen Cursed Clash**.

It scans your mod folders, lets you enable/disable mods, checks required runtime components, and builds a merged mod package for `Content/Paks/~mods`.

## Quick Start (Players)

1. Install dependencies and launch the app:
   ```bash
   npm install
   npm start
   ```
2. On first launch, select `Jujutsu Kaisen CC.exe`.
3. Put your mods in the detected `Content/Mods` folder (or set an override in Settings).
4. Enable the mods you want in the list.
5. Click **Install Mods** to deploy to `Content/Paks/~mods`.
6. Click **Play** to launch the game.

## Features

- Detects mods from your `Content/Mods` folder (or a custom override).
- Enable/disable individual mods, or toggle all mods at once.
- Shows per-mod content checklist:
  - `AssetRegistry.json`
  - prebuilt packages (`.pak/.utoc/.ucas`)
  - `assets/`
  - `datatables/`
  - `pak_assets/`
- Installs all enabled mods via one pipeline:
  - merges DataTable JSON files
  - merges AssetRegistry entries
  - stages loose assets
  - builds IoStore files (`.utoc/.ucas`) via `retoc`
  - builds registry `.pak` via `repak`
  - deploys output to game `Content/Paks/~mods`
- Supports packaging a single mod folder into a zip file.
- Built-in requirements checker with optional install/download actions.
- Launch game directly from the app.

## Requirements

- Windows
- `Jujutsu Kaisen CC.exe`
- Node.js + npm (for building/running from source)

The app also checks runtime modding dependencies from the Requirements modal, including:

- UTOC Signature Bypass
- DataTable Patcher
- UE4SS

## Installation (From Source)

```bash
npm install
```

`postinstall` also installs dependencies for `AssetRegistryPatcher`.

## Run

```bash
npm start
```

On first launch, select `Jujutsu Kaisen CC.exe` when prompted.

## Build

Create Windows installer:

```bash
npm run build
```

Create portable Windows build:

```bash
npm run build:portable
```

## Mod Folder Structure

Each mod should be a folder under your mods workspace (normally `.../Content/Mods/<ModId>`).  
A mod can contain any of the following:

- `manifest.json` (metadata such as title/description/priority)
- `AssetRegistry.json` (array of asset registry entries)
- `assets/` (loose files mirroring game-relative content structure)
- `datatables/*.json` (merged by filename into `_ModManager`)
- `pak_assets/` (files added into the generated registry pak)
- prebuilt package files in mod root:
  - `*.pak`
  - `*.utoc`
  - `*.ucas`

Example:

```text
MyCoolMod/
  manifest.json
  AssetRegistry.json
  assets/
    Jujutsu Kaisen CC/
      Content/
        Mods/
          MyCoolMod/
            SomeAsset.uasset
  datatables/
    AttackSetDataTable.json
  pak_assets/
    Jujutsu Kaisen CC/
      Config/
        DefaultEngine.ini
  MyCoolMod_P.pak
  MyCoolMod_P.utoc
  MyCoolMod_P.ucas
```

## Packaging Behavior

When you click **Install Mods**, the app:

1. Resolves enabled mods and applies mod priority (low to high, high priority wins on conflicts).
2. Clears the game `Content/Paks/~mods` folder for a clean deployment.
3. Combines `datatables/*.json` into:
   - `Content/DataTables/_ModManager/*.json`
4. Builds merged `AssetRegistry.bin`.
5. Stages loose assets and produces:
   - `build/output/zModLoader_P.pak`
   - `build/output/zModLoader_P.utoc`
   - `build/output/zModLoader_P.ucas`
6. Copies generated files (plus any mod prebuilt packages) to:
   - `Content/Paks/~mods`

## Project Scripts

- `npm start` - build patcher then launch Electron app
- `npm run patcher:build` - build `AssetRegistryPatcher`
- `npm run build` - package app via `electron-builder` (Windows x64)
- `npm run build:portable` - portable Windows package

## Repository Layout

- `main.js` - Electron bootstrap
- `preload.js` - secure IPC bridge to renderer
- `lib/` - packaging pipeline, IPC handlers, helpers
- `renderer/` - UI markup, styles, frontend logic
- `AssetRegistryPatcher/` - registry patcher project
- `data/` - baseline data (including `DefaultGame.ini`)
- `tools/` - external tool binaries/resources used by packaging

## Notes

- Build outputs and generated mod artifacts are intentionally ignored via `.gitignore` (`build/`, `mods/`, `node_modules/`, `dist/`).
- This repository currently has active local changes; if you plan to commit this README separately, stage only `README.md`.

## Credits

## Credits
This project utilizes the following open-source components:

* **[UniversalSigBypasser](https://github.com/rm-NoobInCoding/UniversalSigBypasser)** by [rm-NoobInCoding](https://github.com/rm-NoobInCoding) 
  * Licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

