/* JJK CC Mod Manager — renderer */
"use strict";

const $ = (id) => document.getElementById(id);

const settingsModalEl = $("settingsModal");
const openSettingsBtn = $("openSettingsBtn");
const closeSettingsBtn = $("closeSettingsBtn");
const packageModalEl = $("packageModal");
const packageHeadingEl = $("packageHeading");
const closePackageModalBtn = $("closePackageModalBtn");
const packageStepTextEl = $("packageStepText");
const packageProgressFillEl = $("packageProgressFill");
const packageConsoleEl = $("packageConsole");
const modsFolderPathEl = $("modsFolderPath");
const gameFolderPathEl = $("gameFolderPath");
const unpackedAssetsPathEl = $("unpackedAssetsPath");
const modListEl = $("modList");
const installModBtn = $("installModBtn");
const packageAllBtn = $("packageAllBtn");
const launchGameBtn = $("launchGameBtn");
const changePathBtn = $("changePathBtn");
const openModsFolderBtn = $("openModsFolderBtn");
const refreshModsBtn = $("refreshModsBtn");
const enableAllModsBtn = $("enableAllModsBtn");
const disableAllModsBtn = $("disableAllModsBtn");
const setUnpackedAssetsPathBtn = $("setUnpackedAssetsPathBtn");
const clearUnpackedAssetsPathBtn = $("clearUnpackedAssetsPathBtn");
const setModsFolderOverrideBtn = $("setModsFolderOverrideBtn");
const clearModsFolderOverrideBtn = $("clearModsFolderOverrideBtn");
const requirementsBadge = $("requirementsBadge");
const openRequirementsBtn = $("openRequirementsBtn");
const updateBadge = $("updateBadge");
const updateBadgeText = $("updateBadgeText");
const openLatestReleaseBtn = $("openLatestReleaseBtn");
const requirementsModalEl = $("requirementsModal");
const closeRequirementsBtn = $("closeRequirementsBtn");
const refreshRequirementsBtn = $("refreshRequirementsBtn");
const requirementsListEl = $("requirementsList");
const verboseOutputCheckbox = $("verboseOutputCheckbox");
// New UI
const modSearchInput = $("modSearchInput");
const clearSearchBtn = $("clearSearchBtn");
const modSortSelect = $("modSortSelect");
const modCountBadge = $("modCountBadge");
const statusModsText = $("statusModsText");
const statusModsDot = $("statusModsDot");
const statusGameText = $("statusGameText");
const statusGameDot = $("statusGameDot");
const toastRoot = $("toastRoot");
const filterButtons = Array.from(document.querySelectorAll(".segmented-btn"));
const conflictsBtn = $("conflictsBtn");
const conflictsCount = $("conflictsCount");
const conflictsModalEl = $("conflictsModal");
const conflictsListEl = $("conflictsList");
const conflictsSubEl = $("conflictsSub");
const conflictsShowAllBtn = $("conflictsShowAllBtn");
const closeConflictsBtn = $("closeConflictsBtn");

let currentModsFolder = null;
let lastModsState = null;
let packageModalCanClose = false;
let latestReleaseUrl = null;
let activeModToolsClose = null;

// Library view state
let allMods = [];
let activeFilter = "all";
let searchQuery = "";
let sortMode = "priority";

// Overlap state (enabled mods only, from main process)
let currentConflicts = { total: 0, truncated: false, conflicts: [], byMod: {}, scannedMods: 0, warnings: [] };
let conflictFilterModId = null;

function emptyConflicts() {
  return { total: 0, truncated: false, conflicts: [], byMod: {}, scannedMods: 0, warnings: [] };
}

document.addEventListener("click", () => {
  if (activeModToolsClose) {
    activeModToolsClose();
    activeModToolsClose = null;
  }
});

/* ── Toasts ─────────────────────────────────────────────── */

function showToast(kind, title, message, timeout = 4200) {
  if (!toastRoot) {
    if (kind === "error") alert(`${title}\n${message || ""}`);
    return;
  }
  const el = document.createElement("div");
  el.className = `toast toast--${kind || "info"}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = kind === "success" ? "✓" : kind === "error" ? "⚠" : "ℹ";
  el.appendChild(icon);

  const body = document.createElement("div");
  body.className = "toast-body";
  const t = document.createElement("div");
  t.className = "toast-title";
  t.textContent = title;
  body.appendChild(t);
  if (message) {
    const m = document.createElement("div");
    m.className = "toast-msg";
    m.textContent = message;
    body.appendChild(m);
  }
  el.appendChild(body);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "✕";
  close.addEventListener("click", () => dismissToast(el));
  el.appendChild(close);

  toastRoot.appendChild(el);
  while (toastRoot.children.length > 4) toastRoot.firstChild.remove();
  if (timeout > 0) setTimeout(() => dismissToast(el), timeout);
}

function dismissToast(el) {
  if (!el || !el.isConnected) return;
  el.classList.add("toast--out");
  setTimeout(() => el.remove(), 200);
}

const toastSuccess = (t, m) => showToast("success", t, m);
const toastError = (t, m) => showToast("error", t, m, 6500);
const toastInfo = (t, m) => showToast("info", t, m);

/* ── Modals ─────────────────────────────────────────────── */

function setSettingsOpen(open) {
  if (settingsModalEl) {
    settingsModalEl.hidden = !open;
    if (open) closeSettingsBtn?.focus();
  }
}

function setPackageModalOpen(open) {
  if (packageModalEl) packageModalEl.hidden = !open;
}

function setPackageModalTitle(title) {
  if (packageHeadingEl) packageHeadingEl.textContent = title;
}

function setPackageProgress(progress, stepText) {
  const p = Math.max(0, Math.min(100, Number(progress) || 0));
  if (packageProgressFillEl) packageProgressFillEl.style.width = `${p}%`;
  if (packageStepTextEl && stepText) packageStepTextEl.textContent = `${stepText} (${Math.round(p)}%)`;
}

function appendPackageLog(line) {
  if (!packageConsoleEl) return;
  packageConsoleEl.textContent += `${line}\n`;
  packageConsoleEl.scrollTop = packageConsoleEl.scrollHeight;
}

function setRequirementsModalOpen(open) {
  if (requirementsModalEl) requirementsModalEl.hidden = !open;
}

/* ── Skeletons / empty states ───────────────────────────── */

function renderSkeletons(count = 4) {
  if (!modListEl) return;
  modListEl.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    li.className = "mod-skeleton";
    li.setAttribute("aria-hidden", "true");
    for (const w of ["60%", "90%", "40%"]) {
      const s = document.createElement("span");
      s.style.width = w;
      li.appendChild(s);
    }
    modListEl.appendChild(li);
  }
}

function renderEmptyState() {
  modListEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "mod-empty";

  const icon = document.createElement("div");
  icon.className = "mod-empty-icon";
  icon.textContent = searchQuery || activeFilter !== "all" ? "🔍" : "📦";
  li.appendChild(icon);

  const h = document.createElement("h3");
  if (!allMods.length) {
    h.textContent = currentModsFolder ? "No mods found" : "No mods folder linked";
  } else {
    h.textContent = "No mods match your search";
  }
  li.appendChild(h);

  const p = document.createElement("p");
  if (!allMods.length) {
    p.textContent = currentModsFolder
      ? "Drop mod folders into your Content/Mods directory — or install one from a .zip to get started."
      : "Link your game executable in Settings so the manager can find your Content/Mods folder.";
  } else {
    p.textContent = `Nothing matches "${searchQuery}" under the "${activeFilter}" filter. Try clearing your search or switching filters.`;
  }
  li.appendChild(p);

  const actions = document.createElement("div");
  actions.className = "mod-empty-actions";
  if (searchQuery || activeFilter !== "all") {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-small btn-secondary";
    clearBtn.textContent = "Clear search & filters";
    clearBtn.addEventListener("click", () => {
      searchQuery = "";
      if (modSearchInput) modSearchInput.value = "";
      setFilter("all");
      renderMods();
    });
    actions.appendChild(clearBtn);
  } else if (currentModsFolder) {
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "btn btn-small btn-secondary";
    installBtn.textContent = "Add mod from file…";
    installBtn.addEventListener("click", () => installModBtn?.click());
    actions.appendChild(installBtn);
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-small btn-ghost";
    openBtn.textContent = "Open mods folder";
    openBtn.addEventListener("click", () => openModsFolderBtn?.click());
    actions.appendChild(openBtn);
  } else {
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "btn btn-small btn-secondary";
    settingsBtn.textContent = "Open Settings";
    settingsBtn.addEventListener("click", () => setSettingsOpen(true));
    actions.appendChild(settingsBtn);
  }
  li.appendChild(actions);
  modListEl.appendChild(li);
}

/* ── Filtering / sorting ────────────────────────────────── */

function setFilter(f) {
  activeFilter = f;
  for (const b of filterButtons) {
    const on = b.dataset.filter === f;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
}

function getVisibleMods() {
  const q = searchQuery.trim().toLowerCase();
  let list = allMods.filter((m) => {
    if (activeFilter === "enabled" && !m.enabled) return false;
    if (activeFilter === "disabled" && m.enabled) return false;
    if (q) {
      const hay = `${m.title || ""} ${m.folderName || ""} ${m.id || ""} ${m.description || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  list = [...list];
  if (sortMode === "name") {
    list.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  } else if (sortMode === "enabled") {
    list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.priority - a.priority) || (a.title || "").localeCompare(b.title || ""));
  } else {
    list.sort((a, b) => (b.priority - a.priority) || (a.title || "").localeCompare(b.title || ""));
  }
  return list;
}

function updateCounts() {
  const total = allMods.length;
  const enabled = allMods.filter((m) => m.enabled).length;
  if (modCountBadge) modCountBadge.textContent = `${enabled} / ${total} enabled`;
  const heading = $("modsHeading");
  if (heading) heading.textContent = total === 1 ? "Mod library" : "Mod library";
}

/* ── Mod list rendering ─────────────────────────────────── */

const CHIP_DEFS = [
  { key: "registry", label: "Registry", title: "Contains AssetRegistry.json" },
  { key: "packages", label: "Packages", title: "Contains a matching .pak + .utoc + .ucas set in the mod root" },
  { key: "assets", label: "Assets", title: "Contains an assets/ folder with loose files" },
  { key: "datatables", label: "Datatables", title: "Contains datatables/*.json patches" },
  { key: "parameters", label: "Parameters", title: "Contains parameters/*.json patches" },
  { key: "pakAssets", label: "PAK assets", title: "Contains a pak_assets/ folder" },
];

function avatarHue(id) {
  let h = 0;
  for (const ch of String(id || "?")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/** Builds the 40px mod icon (manifest `icon`) or a letter fallback tile. */
function buildModIcon(mod) {
  const wrap = document.createElement("div");
  wrap.className = "mod-icon-wrap";
  if (mod.icon) {
    const img = document.createElement("img");
    img.className = "mod-icon";
    img.src = mod.icon;
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => {
      // Broken image data → swap to the letter fallback in place.
      const avatar = document.createElement("div");
      avatar.className = "mod-avatar";
      avatar.style.setProperty("--avatar-hue", avatarHue(mod.id));
      avatar.textContent = (mod.title || mod.id || "?").trim().charAt(0).toUpperCase() || "?";
      avatar.setAttribute("aria-hidden", "true");
      img.replaceWith(avatar);
    });
    wrap.appendChild(img);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "mod-avatar";
    avatar.style.setProperty("--avatar-hue", avatarHue(mod.id));
    avatar.textContent = (mod.title || mod.id || "?").trim().charAt(0).toUpperCase() || "?";
    avatar.setAttribute("aria-hidden", "true");
    wrap.appendChild(avatar);
  }
  const dot = document.createElement("span");
  dot.className = `mod-icon-dot${mod.enabled ? " mod-icon-dot--on" : ""}`;
  dot.title = mod.enabled ? "Enabled" : "Disabled";
  wrap.appendChild(dot);
  // Non-default priority lives here instead of the title row: a quiet
  // corner badge. Ordering is already visible via sort + conflict winners.
  if (mod.priority) {
    const badge = document.createElement("span");
    badge.className = "mod-priority-badge";
    badge.textContent = String(mod.priority);
    badge.title = `Load priority ${mod.priority} — higher wins file conflicts`;
    wrap.appendChild(badge);
  }
  return wrap;
}

function renderMods() {
  if (!modListEl) return;
  modListEl.innerHTML = "";
  updateCounts();

  const visible = getVisibleMods();
  if (!visible.length) {
    renderEmptyState();
    return;
  }

  for (const mod of visible) {
    const li = document.createElement("li");
    li.className = `mod-item${mod.enabled ? " mod-item--on" : ""}`;
    li.dataset.modId = mod.id;

    // ── Head ──
    const head = document.createElement("div");
    head.className = "mod-head";

    head.appendChild(buildModIcon(mod));
    const dot = head.querySelector(".mod-icon-dot");

    const titleBlock = document.createElement("div");
    titleBlock.className = "mod-title-block";
    const titleRow = document.createElement("div");
    titleRow.className = "mod-title-row";
    const title = document.createElement("span");
    title.className = "mod-title";
    title.textContent = mod.title || mod.id;
    title.title = mod.title || mod.id;
    titleRow.appendChild(title);
    if (mod.version) {
      const ver = document.createElement("span");
      ver.className = "mod-version";
      ver.textContent = `v${mod.version}`;
      ver.title = `Version ${mod.version}`;
      titleRow.appendChild(ver);
    }
    titleBlock.appendChild(titleRow);

    const folder = document.createElement("span");
    folder.className = "mod-folder";
    folder.textContent = mod.folderName || mod.id;
    folder.title = mod.fullPath || mod.folderName || mod.id;
    titleBlock.appendChild(folder);
    head.appendChild(titleBlock);

    const headRight = document.createElement("div");
    headRight.className = "mod-head-right";

    // Toggle
    const toggleWrap = document.createElement("label");
    toggleWrap.className = `mod-toggle${mod.enabled ? " mod-toggle--on" : ""}`;
    toggleWrap.title = mod.enabled ? "Click to disable" : "Click to enable";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "mod-toggle-input";
    toggle.checked = Boolean(mod.enabled);
    toggle.setAttribute("aria-label", `${mod.enabled ? "Disable" : "Enable"} mod ${mod.title}`);
    const track = document.createElement("span");
    track.className = "mod-toggle-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("span");
    thumb.className = "mod-toggle-thumb";
    track.appendChild(thumb);
    const stateLabel = document.createElement("span");
    stateLabel.className = "mod-toggle-label";
    stateLabel.textContent = toggle.checked ? "On" : "Off";

    const syncToggleUi = () => {
      stateLabel.textContent = toggle.checked ? "On" : "Off";
      toggle.setAttribute("aria-label", `${toggle.checked ? "Disable" : "Enable"} mod ${mod.title}`);
      toggleWrap.classList.toggle("mod-toggle--on", toggle.checked);
      li.classList.toggle("mod-item--on", toggle.checked);
      if (dot) {
        dot.classList.toggle("mod-icon-dot--on", toggle.checked);
        dot.title = toggle.checked ? "Enabled" : "Disabled";
      }
    };

    toggle.addEventListener("change", async () => {
      syncToggleUi();
      toggle.disabled = true;
      toggleWrap.classList.add("mod-toggle--busy");
      try {
        const res = await window.modManagerApi.setModEnabled(mod.id, toggle.checked);
        mod.enabled = toggle.checked;
        if (res && res.conflicts) {
          currentConflicts = res.conflicts;
          updateConflictsUI();
          updateConflictBadges();
        }
        updateCounts();
        const enabledCount = allMods.filter((m) => m.enabled).length;
        if (packageAllBtn) {
          packageAllBtn.disabled = !currentModsFolder || enabledCount === 0;
          packageAllBtn.title = enabledCount
            ? `Merge and install ${enabledCount} enabled mod${enabledCount === 1 ? "" : "s"} into the game`
            : "Enable at least one mod first";
        }
        if (!matchesCurrentFilter(mod)) renderMods();
      } catch {
        toggle.checked = !toggle.checked;
        syncToggleUi();
        toastError("Toggle failed", `Could not ${toggle.checked ? "enable" : "disable"} "${mod.title}".`);
      } finally {
        toggle.disabled = false;
        toggleWrap.classList.remove("mod-toggle--busy");
      }
    });

    toggleWrap.append(toggle, track, stateLabel);
    headRight.appendChild(toggleWrap);
    head.appendChild(headRight);
    li.appendChild(head);

    // ── Description ──
    if (mod.description) {
      const description = document.createElement("p");
      description.className = "mod-description";
      description.textContent = mod.description;
      description.title = mod.description;
      li.appendChild(description);
    }

    // ── Footer: chips + tools ──
    const footer = document.createElement("div");
    footer.className = "mod-item-footer";

    const chips = document.createElement("div");
    chips.className = "mod-chips";
    const c = mod.checklist || {};
    for (const def of CHIP_DEFS) {
      const ok = Boolean(c[def.key]);
      const chip = document.createElement("span");
      chip.className = `chip ${ok ? "chip--on" : "chip--off"}`;
      chip.title = `${def.label}: ${ok ? "present" : "not present"} — ${def.title}`;
      const dotEl = document.createElement("i");
      chip.appendChild(dotEl);
      const label = document.createElement("span");
      label.textContent = def.label;
      chip.appendChild(label);
      chips.appendChild(chip);
    }
    footer.appendChild(chips);

    const overlap = currentConflicts.byMod && currentConflicts.byMod[mod.id];
    if (overlap && overlap.total > 0 && mod.enabled) {
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "conflict-badge";
      badge.title = `${overlap.total} overlapping file${overlap.total === 1 ? "" : "s"} with other enabled mods — click to inspect`;
      badge.setAttribute("aria-label", `Show ${overlap.total} overlaps for ${mod.title}`);
      const warn = document.createElement("span");
      warn.setAttribute("aria-hidden", "true");
      warn.textContent = "⚠";
      badge.appendChild(warn);
      const tx = document.createElement("span");
      tx.textContent = `${overlap.total} overlap${overlap.total === 1 ? "" : "s"}`;
      badge.appendChild(tx);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        openConflictsModal(mod.id);
      });
      footer.appendChild(badge);
    }

    footer.appendChild(buildToolsMenu(mod));
    li.appendChild(footer);
    modListEl.appendChild(li);
  }
}

function matchesCurrentFilter(mod) {
  if (activeFilter === "enabled" && !mod.enabled) return false;
  if (activeFilter === "disabled" && mod.enabled) return false;
  return true;
}

function buildToolsMenu(mod) {
  const toolsWrap = document.createElement("div");
  toolsWrap.className = "mod-tools mod-tools--footer";

  const toolsBtn = document.createElement("button");
  toolsBtn.type = "button";
  toolsBtn.className = "mod-tools-trigger";
  toolsBtn.innerHTML = `<span aria-hidden="true">⋯</span><span>Tools</span>`;
  toolsBtn.setAttribute("aria-haspopup", "menu");
  toolsBtn.setAttribute("aria-expanded", "false");
  toolsBtn.setAttribute("aria-label", `Tools menu for ${mod.title}`);

  const toolsMenu = document.createElement("div");
  toolsMenu.className = "mod-tools-menu";
  toolsMenu.setAttribute("role", "menu");
  toolsMenu.hidden = true;

  function closeToolsMenu() {
    toolsMenu.hidden = true;
    toolsBtn.setAttribute("aria-expanded", "false");
    if (activeModToolsClose === closeToolsMenu) activeModToolsClose = null;
  }
  function openToolsMenu() {
    if (activeModToolsClose && activeModToolsClose !== closeToolsMenu) {
      activeModToolsClose();
      activeModToolsClose = null;
    }
    toolsMenu.hidden = false;
    toolsBtn.setAttribute("aria-expanded", "true");
    activeModToolsClose = closeToolsMenu;
  }

  toolsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (toolsMenu.hidden) openToolsMenu();
    else closeToolsMenu();
  });
  toolsMenu.addEventListener("click", (e) => e.stopPropagation());

  const addItem = (label, icon, handler, disabled = false) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mod-tools-menu-item";
    item.setAttribute("role", "menuitem");
    item.disabled = disabled;
    const ic = document.createElement("span");
    ic.setAttribute("aria-hidden", "true");
    ic.textContent = icon;
    item.appendChild(ic);
    const tx = document.createElement("span");
    tx.textContent = label;
    item.appendChild(tx);
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeToolsMenu();
      await handler(item);
    });
    toolsMenu.appendChild(item);
    return item;
  };

  addItem("Open mod folder", "📁", async () => {
    try {
      await window.modManagerApi.openModFolder(mod.fullPath);
    } catch (error) {
      toastError("Could not open folder", error.message);
    }
  });

  addItem("Copy mod path", "⧉", async () => {
    try {
      await navigator.clipboard.writeText(mod.fullPath);
      toastSuccess("Path copied", mod.fullPath);
    } catch {
      toastError("Copy failed", "Could not copy the mod path to the clipboard.");
    }
  });

  addItem("Package mod (zip)", "📦", async (item) => {
    item.disabled = true;
    packageModalCanClose = false;
    if (closePackageModalBtn) closePackageModalBtn.disabled = true;
    if (packageConsoleEl) packageConsoleEl.textContent = "";
    setPackageModalTitle(`Package — ${mod.title}`);
    setPackageProgress(4, "Zipping mod");
    appendPackageLog(`[info] Packaging ${mod.title} as zip…`);
    setPackageModalOpen(true);
    try {
      setPackageProgress(50, "Zipping mod");
      const result = await window.modManagerApi.packageSingleMod(mod.fullPath);
      setPackageProgress(100, "Done");
      appendPackageLog(`[done] Output: ${result.zipPath}`);
      toastSuccess("Mod packaged", result.zipPath);
    } catch (error) {
      appendPackageLog(`[error] ${error.message}`);
      toastError("Packaging failed", error.message);
    } finally {
      packageModalCanClose = true;
      if (closePackageModalBtn) closePackageModalBtn.disabled = false;
      item.disabled = false;
    }
  });

  toolsWrap.append(toolsBtn, toolsMenu);
  return toolsWrap;
}

/* ── Overlap (conflicts) UI ───────────────────────────────── */

const CONFLICT_TYPE_LABELS = {
  datatable: "Row",
  asset: "Asset",
  pakAsset: "PAK",
  registry: "Registry",
  prebuilt: "Package",
};

function setConflictsModalOpen(open) {
  if (conflictsModalEl) conflictsModalEl.hidden = !open;
}

function updateConflictsUI() {
  const total = currentConflicts.total || 0;
  if (conflictsBtn) conflictsBtn.hidden = total === 0;
  if (conflictsCount) {
    conflictsCount.textContent = `${total} overlap${total === 1 ? "" : "s"}${currentConflicts.truncated ? "+" : ""}`;
  }
  if (conflictsBtn) {
    conflictsBtn.title = total
      ? `${total} overlapping file${total === 1 ? "" : "s"} between enabled mods — click to inspect`
      : "No overlaps between enabled mods";
  }
}

/** Refreshes per-card overlap badges in place (no full re-render). */
function updateConflictBadges() {
  if (!modListEl) return;
  for (const li of modListEl.querySelectorAll(".mod-item[data-mod-id]")) {
    const modId = li.dataset.modId;
    const mod = allMods.find((m) => m.id === modId);
    const overlap = currentConflicts.byMod && currentConflicts.byMod[modId];
    const want = Boolean(overlap && overlap.total > 0 && mod && mod.enabled);
    let badge = li.querySelector(".conflict-badge");
    if (!want) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      const footer = li.querySelector(".mod-item-footer");
      if (!footer) continue;
      badge = document.createElement("button");
      badge.type = "button";
      badge.className = "conflict-badge";
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        openConflictsModal(modId);
      });
      footer.insertBefore(badge, footer.lastElementChild);
    }
    badge.title = `${overlap.total} overlapping file${overlap.total === 1 ? "" : "s"} with other enabled mods — click to inspect`;
    badge.setAttribute("aria-label", `Show ${overlap.total} overlaps for ${mod ? mod.title : modId}`);
    badge.innerHTML = "";
    const warn = document.createElement("span");
    warn.setAttribute("aria-hidden", "true");
    warn.textContent = "⚠";
    const tx = document.createElement("span");
    tx.textContent = `${overlap.total} overlap${overlap.total === 1 ? "" : "s"}`;
    badge.append(warn, tx);
  }
}

function openConflictsModal(filterModId = null) {
  conflictFilterModId = filterModId;
  renderConflictsList();
  setConflictsModalOpen(true);
}

function renderConflictsList() {
  if (!conflictsListEl) return;
  conflictsListEl.innerHTML = "";

  const all = currentConflicts.conflicts || [];
  const list = conflictFilterModId
    ? all.filter((c) => (c.mods || []).some((m) => m.id === conflictFilterModId))
    : all;

  if (conflictsShowAllBtn) conflictsShowAllBtn.hidden = !conflictFilterModId;
  if (conflictsSubEl) {
    if (conflictFilterModId) {
      const mod = allMods.find((m) => m.id === conflictFilterModId);
      conflictsSubEl.textContent = `Overlaps involving “${mod ? mod.title : conflictFilterModId}” (${list.length})`;
    } else {
      conflictsSubEl.textContent = currentConflicts.total
        ? `${currentConflicts.total} overlapping file${currentConflicts.total === 1 ? "" : "s"} across ${currentConflicts.scannedMods} enabled mod${currentConflicts.scannedMods === 1 ? "" : "s"}${currentConflicts.truncated ? " (showing first 400)" : ""}`
        : "Enabled mods writing to the same path or row";
    }
  }

  if (!list.length) {
    const li = document.createElement("li");
    li.className = "conflicts-empty";
    li.textContent = conflictFilterModId
      ? "No overlaps involve this mod."
      : "No overlaps — enabled mods touch distinct files and rows. ✓";
    conflictsListEl.appendChild(li);
    return;
  }

  for (const c of list) {
    const li = document.createElement("li");
    li.className = "conflict-item";

    const top = document.createElement("div");
    top.className = "conflict-top";
    const tag = document.createElement("span");
    tag.className = `conflict-type conflict-type--${c.type}`;
    tag.textContent = CONFLICT_TYPE_LABELS[c.type] || c.type;
    tag.title = conflictTypeHint(c.type);
    top.appendChild(tag);
    const key = document.createElement("span");
    key.className = "conflict-key";
    key.textContent = c.key;
    key.title = c.key;
    top.appendChild(key);
    li.appendChild(top);

    const modsRow = document.createElement("div");
    modsRow.className = "conflict-mods";
    // Winner last (pipeline order) — display winner first for scannability.
    const ordered = [...(c.mods || [])].sort((a, b) => (a.id === c.winnerId ? 1 : b.id === c.winnerId ? -1 : b.priority - a.priority));
    for (const m of ordered) {
      const chip = document.createElement("span");
      chip.className = `conflict-mod${m.id === c.winnerId ? " conflict-mod--winner" : ""}`;
      chip.title = m.id === c.winnerId ? "Highest priority — wins this file/row" : "Overridden on this file/row";
      const nm = document.createElement("span");
      nm.textContent = `${m.id === c.winnerId ? "★ " : ""}${m.title || m.id}`;
      chip.appendChild(nm);
      const pri = document.createElement("span");
      pri.className = "conflict-mod-pri";
      pri.textContent = `P${m.priority ?? 0}`;
      chip.appendChild(pri);
      modsRow.appendChild(chip);
    }
    li.appendChild(modsRow);
    conflictsListEl.appendChild(li);
  }
}

function conflictTypeHint(type) {
  switch (type) {
    case "datatable": return "Same datatable row key in 2+ mods — higher priority value wins";
    case "parameter": return "Same parameters/ row key in 2+ mods — higher priority value wins";
    case "asset": return "Same assets/ path in 2+ mods — higher priority file overwrites";
    case "pakAsset": return "Same pak_assets/ path in 2+ mods — higher priority file overwrites";
    case "registry": return "Same AssetRegistry objectName in 2+ mods — higher priority entry wins";
    case "prebuilt": return "Same prebuilt package file name in 2+ mods — higher priority file overwrites in ~mods";
    default: return "Overlapping file between enabled mods";
  }
}

/* ── Paths / status bar ─────────────────────────────────── */

function dirname(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const i = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  if (i <= 0) return null;
  return filePath.slice(0, i);
}

function shortPath(p, max = 52) {
  if (!p) return "";
  if (p.length <= max) return p;
  const half = Math.floor((max - 3) / 2);
  return `${p.slice(0, half)}…${p.slice(-half)}`;
}

function setSettingsPaths(modsPath, gameExePath, unpackedAssetsPath, modsFolderOverride) {
  const gameFolder = dirname(gameExePath);
  if (gameFolderPathEl) {
    gameFolderPathEl.hidden = false;
    if (gameFolder) {
      gameFolderPathEl.classList.remove("path-line--empty");
      gameFolderPathEl.textContent = gameFolder;
      gameFolderPathEl.title = gameExePath;
    } else {
      gameFolderPathEl.classList.add("path-line--empty");
      gameFolderPathEl.textContent = "No game linked yet — choose your Jujutsu Kaisen CC.exe.";
    }
  }
  if (modsFolderPathEl) {
    modsFolderPathEl.hidden = false;
    if (modsPath) {
      modsFolderPathEl.classList.remove("path-line--empty");
      modsFolderPathEl.textContent = modsPath + (modsFolderOverride ? "  (custom)" : "");
      modsFolderPathEl.title = modsPath;
    } else {
      modsFolderPathEl.classList.add("path-line--empty");
      modsFolderPathEl.textContent = "(not available)";
    }
  }
  if (unpackedAssetsPathEl) {
    unpackedAssetsPathEl.hidden = false;
    if (unpackedAssetsPath) {
      unpackedAssetsPathEl.classList.remove("path-line--empty");
      unpackedAssetsPathEl.textContent = unpackedAssetsPath;
      unpackedAssetsPathEl.title = unpackedAssetsPath;
    } else {
      unpackedAssetsPathEl.classList.add("path-line--empty");
      unpackedAssetsPathEl.textContent = "(not set — optional)";
    }
  }
  if (clearModsFolderOverrideBtn) {
    clearModsFolderOverrideBtn.disabled = !modsFolderOverride;
  }

  // Status bar
  if (statusModsText) {
    statusModsText.textContent = modsPath ? shortPath(modsPath) : "No mods folder";
    statusModsText.title = modsPath || "";
  }
  if (statusModsDot) {
    statusModsDot.className = `status-dot${modsPath ? " status-dot--ok" : " status-dot--warn"}`;
  }
  if (statusGameText) {
    statusGameText.textContent = gameFolder ? shortPath(gameFolder) : "No game linked";
    statusGameText.title = gameExePath || "";
  }
  if (statusGameDot) {
    statusGameDot.className = `status-dot${gameFolder ? " status-dot--ok" : " status-dot--warn"}`;
  }
}

/* ── Requirements ───────────────────────────────────────── */

function renderRequirements(statuses) {
  if (!requirementsListEl) return;
  requirementsListEl.innerHTML = "";

  if (!statuses || statuses.length === 0) {
    const li = document.createElement("li");
    li.className = "req-item";
    li.textContent = "No requirements defined.";
    requirementsListEl.appendChild(li);
    return;
  }

  for (const req of statuses) {
    const li = document.createElement("li");
    li.className = "req-item";

    const info = document.createElement("div");
    info.className = "req-info";
    const name = document.createElement("span");
    name.className = "req-name";
    name.textContent = req.name;
    info.appendChild(name);
    if (req.description) {
      const desc = document.createElement("span");
      desc.className = "req-description";
      desc.textContent = req.description;
      info.appendChild(desc);
    }
    if (req.statusDetail && req.installed !== true) {
      const detail = document.createElement("span");
      detail.className = "req-description";
      detail.textContent = req.statusDetail;
      info.appendChild(detail);
    }

    const actions = document.createElement("div");
    actions.className = "req-actions";

    const statusBadge = document.createElement("span");
    if (req.installed === true) {
      statusBadge.className = "req-status req-status--ok";
      statusBadge.textContent = "Installed";
    } else if (req.installed === "outdated") {
      statusBadge.className = "req-status req-status--outdated";
      statusBadge.textContent = "Outdated";
    } else if (req.installed === false) {
      statusBadge.className = "req-status req-status--missing";
      statusBadge.textContent = "Not found";
    } else {
      statusBadge.className = "req-status req-status--unknown";
      statusBadge.textContent = "Unknown";
    }
    if (req.statusDetail) statusBadge.title = req.statusDetail;
    actions.appendChild(statusBadge);

    if (req.installed === false || req.installed === "outdated") {
      if (req.url) {
        const downloadBtn = document.createElement("button");
        downloadBtn.type = "button";
        downloadBtn.className = "btn btn-small btn-ghost req-action-btn";
        downloadBtn.textContent = "Download";
        downloadBtn.addEventListener("click", async () => {
          try {
            await window.modManagerApi.openExternalUrl(req.url);
          } catch { /* ignore */ }
        });
        actions.appendChild(downloadBtn);
      }
      if ((req.zipPath && req.installPath) || req.exePath) {
        const installBtn = document.createElement("button");
        installBtn.type = "button";
        installBtn.className = "req-action-btn--install";
        installBtn.textContent = req.installed === "outdated" ? "Update" : "Install";
        installBtn.addEventListener("click", async () => {
          installBtn.disabled = true;
          installBtn.textContent = "Installing…";
          try {
            const updated = await window.modManagerApi.installRequirement(req.id);
            renderRequirements(updated);
            updateRequirementsBadge(updated);
            toastSuccess("Requirement installed", req.name);
          } catch (error) {
            toastError(`Failed to install ${req.name}`, error.message);
            installBtn.disabled = false;
            installBtn.textContent = "Install";
          }
        });
        actions.appendChild(installBtn);
      }
    }

    li.append(info, actions);
    requirementsListEl.appendChild(li);
  }
}

function updateRequirementsBadge(statuses) {
  if (!requirementsBadge) return;
  const hasIssue =
    Array.isArray(statuses) && statuses.some((s) => s.installed === false || s.installed === "outdated");
  requirementsBadge.hidden = !hasIssue;
}

async function loadAndRenderRequirements() {
  try {
    const statuses = await window.modManagerApi.checkRequirements();
    renderRequirements(statuses);
    updateRequirementsBadge(statuses);
  } catch { /* ignore */ }
}

function renderAppUpdateStatus(status) {
  if (!updateBadge || !openLatestReleaseBtn || !status || status.ok !== true) {
    if (updateBadge) updateBadge.hidden = true;
    latestReleaseUrl = null;
    return;
  }
  if (!status.hasRelease || status.upToDate) {
    updateBadge.hidden = true;
    latestReleaseUrl = null;
    return;
  }
  const latest = status.latestVersion || "latest";
  if (updateBadgeText) updateBadgeText.textContent = `Update available (${latest})`;
  updateBadge.hidden = false;
  latestReleaseUrl = status.latestUrl || null;
}

async function checkAndRenderAppUpdateStatus() {
  try {
    const status = await window.modManagerApi.checkAppUpdate();
    renderAppUpdateStatus(status);
  } catch {
    renderAppUpdateStatus(null);
  }
}

/* ── State ──────────────────────────────────────────────── */

function setBulkBusy(busy) {
  for (const b of [refreshModsBtn, enableAllModsBtn, disableAllModsBtn]) {
    if (b) b.disabled = busy || !currentModsFolder;
  }
  if (enableAllModsBtn && !busy) enableAllModsBtn.disabled = !currentModsFolder || allMods.length === 0;
  if (disableAllModsBtn && !busy) disableAllModsBtn.disabled = !currentModsFolder || allMods.length === 0;
  if (refreshModsBtn && !busy) refreshModsBtn.disabled = !currentModsFolder;
}

function applyState(result) {
  currentModsFolder = result.modsFolder || null;
  const hasModsRoot = Boolean(currentModsFolder);
  allMods = Array.isArray(result.mods) ? result.mods : [];
  currentConflicts = result.conflicts && typeof result.conflicts === "object" ? result.conflicts : emptyConflicts();
  updateConflictsUI();

  packageAllBtn.disabled = !hasModsRoot || allMods.filter((m) => m.enabled).length === 0;
  if (installModBtn) installModBtn.disabled = !hasModsRoot;
  if (launchGameBtn) launchGameBtn.disabled = !result.gameLocation;
  if (openModsFolderBtn) openModsFolderBtn.disabled = !hasModsRoot;

  if (clearUnpackedAssetsPathBtn) clearUnpackedAssetsPathBtn.disabled = !result.unpackedAssetsPath;
  if (verboseOutputCheckbox && result.verboseOutput !== undefined) {
    verboseOutputCheckbox.checked = Boolean(result.verboseOutput);
  }
  setSettingsPaths(
    result.modsFolder || null,
    result.gameLocation || null,
    result.unpackedAssetsPath || null,
    result.modsFolderOverride || null,
  );

  // Refresh the primary CTA tooltip with the enabled count.
  const enabledCount = allMods.filter((m) => m.enabled).length;
  if (packageAllBtn) {
    packageAllBtn.title = enabledCount
      ? `Merge and install ${enabledCount} enabled mod${enabledCount === 1 ? "" : "s"} into the game`
      : "Enable at least one mod first";
  }

  renderMods();
  setBulkBusy(false);
  lastModsState = { ...result, mods: allMods };
  loadAndRenderRequirements();
  processPendingOpenFiles();
}

async function init() {
  renderSkeletons(5);
  try {
    const [result] = await Promise.all([
      window.modManagerApi.initApp(),
      checkAndRenderAppUpdateStatus(),
    ]);
    if (result && result.error && !result.gameLocation) {
      renderSkeletons(0);
      modListEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "mod-empty";
      li.innerHTML = "";
      const icon = document.createElement("div");
      icon.className = "mod-empty-icon";
      icon.textContent = "🎮";
      const h = document.createElement("h3");
      h.textContent = "Link your game to begin";
      const p = document.createElement("p");
      p.textContent = result.error || "Select your Jujutsu Kaisen CC.exe when prompted.";
      const actions = document.createElement("div");
      actions.className = "mod-empty-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary";
      btn.textContent = "Open Settings";
      btn.addEventListener("click", () => setSettingsOpen(true));
      actions.appendChild(btn);
      li.append(icon, h, p, actions);
      modListEl.appendChild(li);
      setSettingsPaths(null, null, result.unpackedAssetsPath || null, null);
      toastInfo("Welcome", "Select your game executable to link the mod library.");
      lastModsState = result;
      appReady = true;
      return;
    }
    applyState(result);
    appReady = true;
    processPendingOpenFiles();
  } catch (err) {
    renderEmptyState();
    toastError("Failed to initialise", err?.message || String(err));
    appReady = true;
  }
}

/* ── Events ─────────────────────────────────────────────── */

conflictsBtn?.addEventListener("click", () => openConflictsModal(null));

closeConflictsBtn?.addEventListener("click", () => setConflictsModalOpen(false));
conflictsModalEl?.addEventListener("click", (e) => {
  if (e.target === conflictsModalEl) setConflictsModalOpen(false);
});
conflictsShowAllBtn?.addEventListener("click", () => {
  conflictFilterModId = null;
  renderConflictsList();
});

openRequirementsBtn?.addEventListener("click", () => setRequirementsModalOpen(true));

openLatestReleaseBtn?.addEventListener("click", async () => {
  if (!latestReleaseUrl) return;
  try {
    await window.modManagerApi.openExternalUrl(latestReleaseUrl);
  } catch { /* ignore */ }
});

closeRequirementsBtn?.addEventListener("click", () => setRequirementsModalOpen(false));
requirementsModalEl?.addEventListener("click", (e) => {
  if (e.target === requirementsModalEl) setRequirementsModalOpen(false);
});
refreshRequirementsBtn?.addEventListener("click", async () => {
  refreshRequirementsBtn.disabled = true;
  try {
    await loadAndRenderRequirements();
  } finally {
    refreshRequirementsBtn.disabled = false;
  }
});

refreshModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  setBulkBusy(true);
  renderSkeletons(3);
  try {
    const result = await window.modManagerApi.refreshMods();
    applyState(result);
    toastSuccess("Library refreshed", `${(result.mods || []).length} mod${(result.mods || []).length === 1 ? "" : "s"} found.`);
  } catch (err) {
    if (lastModsState) applyState(lastModsState);
    toastError("Refresh failed", err?.message || String(err));
  }
});

enableAllModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  setBulkBusy(true);
  try {
    const result = await window.modManagerApi.enableAllMods();
    applyState(result);
    toastSuccess("All mods enabled", `${(result.mods || []).length} mods will load next time.`);
  } catch (err) {
    if (lastModsState) applyState(lastModsState);
    toastError("Enable-all failed", err?.message || String(err));
  }
});

disableAllModsBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  setBulkBusy(true);
  try {
    const result = await window.modManagerApi.disableAllMods();
    applyState(result);
    toastInfo("All mods disabled", "Nothing will load until you re-enable a mod.");
  } catch (err) {
    if (lastModsState) applyState(lastModsState);
    toastError("Disable-all failed", err?.message || String(err));
  }
});

openModsFolderBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;
  try {
    await window.modManagerApi.openModsFolder(currentModsFolder);
  } catch (err) {
    toastError("Could not open mods folder", err?.message || String(err));
  }
});

/* Files opened via OS association (.jjkmod double-click) wait here until ready. */
let appReady = false;
let addModBusy = false;
const pendingOpenFiles = [];

function processPendingOpenFiles() {
  if (!appReady || addModBusy || pendingOpenFiles.length === 0 || !currentModsFolder) return;
  installModFile(pendingOpenFiles.shift());
}

/**
 * Adds a mod to the library — from the file picker (null) or an explicit
 * path (OS file association / drag source). Sequential via addModBusy.
 */
async function installModFile(explicitPath) {
  if (addModBusy) {
    if (explicitPath) pendingOpenFiles.unshift(explicitPath);
    return;
  }
  if (!currentModsFolder) {
    if (explicitPath) pendingOpenFiles.unshift(explicitPath);
    toastError("No mods folder yet", "Link your game in Settings first, then open the mod file again.");
    return;
  }
  addModBusy = true;
  installModBtn.disabled = true;
  try {
    const result = explicitPath
      ? await window.modManagerApi.installModFromFile(explicitPath)
      : await window.modManagerApi.installModFromZip();
    if (result.cancelled) return;
    if (result.action === "unchanged") {
      toastInfo(
        "Already up to date",
`"${result.modFolderName}" is already at v${result.incomingVersion || result.existingVersion || "?"}.`,
      );
      return;
    }
    applyState(result);
    if (result.action === "updated") {
      toastSuccess("Mod updated", `"${result.modFolderName}" → v${result.incomingVersion} (was v${result.existingVersion}).`);
    } else {
      toastSuccess("Mod added", `"${result.modFolderName}" (v${result.incomingVersion || "?"}) added to your library.`);
    }
  } catch (error) {
    toastError("Could not add mod", error.message);
  } finally {
    addModBusy = false;
    installModBtn.disabled = !currentModsFolder;
    processPendingOpenFiles();
  }
}

installModBtn?.addEventListener("click", () => installModFile(null));

window.modManagerApi.onOpenModFile?.((files) => {
  for (const f of files || []) pendingOpenFiles.push(f);
  processPendingOpenFiles();
});

changePathBtn?.addEventListener("click", async () => {
  const result = await window.modManagerApi.changeGameLocation();
  if (!result.cancelled) {
    applyState(result);
    toastSuccess("Game linked", result.gameLocation || "Game location updated.");
  }
});

openSettingsBtn?.addEventListener("click", () => setSettingsOpen(true));
closeSettingsBtn?.addEventListener("click", () => setSettingsOpen(false));
settingsModalEl?.addEventListener("click", (e) => {
  if (e.target === settingsModalEl) setSettingsOpen(false);
});

setModsFolderOverrideBtn?.addEventListener("click", async () => {
  try {
    const result = await window.modManagerApi.setModsFolderOverride();
    if (!result.cancelled) {
      applyState(result);
      toastSuccess("Mods folder updated", result.modsFolder || "");
    }
  } catch (err) {
    toastError("Could not set mods folder", err?.message || String(err));
  }
});

clearModsFolderOverrideBtn?.addEventListener("click", async () => {
  try {
    const result = await window.modManagerApi.clearModsFolderOverride();
    applyState(result);
    toastInfo("Mods folder reset", "Using the default Content/Mods location.");
  } catch (err) {
    toastError("Reset failed", err?.message || String(err));
  }
});

closePackageModalBtn?.addEventListener("click", () => {
  if (!packageModalCanClose) return;
  setPackageModalOpen(false);
});
packageModalEl?.addEventListener("click", (e) => {
  if (e.target === packageModalEl && packageModalCanClose) setPackageModalOpen(false);
});

window.modManagerApi.onPackageProgress?.((payload) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "progress") {
    setPackageProgress(payload.progress, payload.step || "Packaging");
    return;
  }
  if (payload.type === "log") {
    const prefix = payload.stream ? `[${payload.stream}] ` : "";
    appendPackageLog(`${prefix}${payload.message ?? ""}`);
    return;
  }
  if (payload.type === "error") {
    appendPackageLog(`[error] ${payload.message ?? "Packaging failed"}`);
    return;
  }
  if (payload.type === "done") {
    appendPackageLog(`[done] ${payload.message ?? "Packaging finished"}`);
  }
});

packageAllBtn?.addEventListener("click", async () => {
  if (!currentModsFolder) return;

  packageAllBtn.disabled = true;
  packageModalCanClose = false;
  if (closePackageModalBtn) closePackageModalBtn.disabled = true;
  if (packageConsoleEl) packageConsoleEl.textContent = "";
  setPackageModalTitle("Install enabled mods");
  setPackageProgress(0, "Starting");
  appendPackageLog("[info] Installing enabled mods into the game…");
  setPackageModalOpen(true);

  try {
    const output = await window.modManagerApi.packageAllMods(currentModsFolder);
    appendPackageLog(`[done] Output: ${output.outputDir}`);
    if (output.gamePaksModsDir) appendPackageLog(`[done] Game folder: ${output.gamePaksModsDir}`);
    toastSuccess("Mods installed", "Enabled mods were merged and installed into the game. You're ready to play!");
  } catch (error) {
    appendPackageLog(`[error] ${error.message}`);
    toastError("Install failed", error.message);
  } finally {
    const enabledCount = allMods.filter((m) => m.enabled).length;
    packageAllBtn.disabled = !currentModsFolder || enabledCount === 0;
    packageModalCanClose = true;
    if (closePackageModalBtn) closePackageModalBtn.disabled = false;
  }
});

setUnpackedAssetsPathBtn?.addEventListener("click", async () => {
  const result = await window.modManagerApi.setUnpackedAssetsPath();
  if (!result.cancelled) {
    applyState(result);
    toastSuccess("Unpacked assets path set", result.unpackedAssetsPath || "");
  }
});

verboseOutputCheckbox?.addEventListener("change", async () => {
  try {
    await window.modManagerApi.setVerboseOutput(verboseOutputCheckbox.checked);
  } catch {
    verboseOutputCheckbox.checked = !verboseOutputCheckbox.checked;
  }
});

clearUnpackedAssetsPathBtn?.addEventListener("click", async () => {
  const ok = window.confirm("Reset unpacked assets path? This clears the saved path from settings.");
  if (!ok) return;
  try {
    const result = await window.modManagerApi.clearUnpackedAssetsPath();
    applyState(result);
  } catch (err) {
    toastError("Reset failed", err?.message || String(err));
  }
});

launchGameBtn?.addEventListener("click", async () => {
  launchGameBtn.disabled = true;
  try {
    await window.modManagerApi.launchGame();
    toastInfo("Launching game", "Jujutsu Kaisen Cursed Clash is starting…");
  } catch (error) {
    toastError("Could not launch game", error.message);
  } finally {
    launchGameBtn.disabled = !lastModsState?.gameLocation;
  }
});

/* ── Search / filter / sort ─────────────────────────────── */

modSearchInput?.addEventListener("input", () => {
  searchQuery = modSearchInput.value || "";
  if (clearSearchBtn) clearSearchBtn.hidden = !searchQuery;
  renderMods();
});

clearSearchBtn?.addEventListener("click", () => {
  if (modSearchInput) modSearchInput.value = "";
  searchQuery = "";
  clearSearchBtn.hidden = true;
  modSearchInput?.focus();
  renderMods();
});

for (const b of filterButtons) {
  b.addEventListener("click", () => {
    setFilter(b.dataset.filter || "all");
    renderMods();
  });
}

modSortSelect?.addEventListener("change", () => {
  sortMode = modSortSelect.value || "priority";
  renderMods();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (conflictsModalEl && !conflictsModalEl.hidden) setConflictsModalOpen(false);
    else if (requirementsModalEl && !requirementsModalEl.hidden) setRequirementsModalOpen(false);
    else if (packageModalEl && !packageModalEl.hidden && packageModalCanClose) setPackageModalOpen(false);
    else if (settingsModalEl && !settingsModalEl.hidden) setSettingsOpen(false);
    return;
  }
  // Press "/" to focus search when not typing in a field.
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      e.preventDefault();
      modSearchInput?.focus();
    }
  }
});

init().catch(() => {});
