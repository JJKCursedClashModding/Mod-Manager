/* Pure display helpers shared by renderer.js (browser global) and tests (CommonJS).
   Wrapped in an IIFE so its names do not clash with renderer.js globals. */
(function () {
"use strict";

/**
 * "v"-prefixed version label. Manifests often already contain "v3" or
 * "V1.2", so a leading v/V before a digit is stripped before prefixing
 * (no "vv3"); non-numeric versions ("beta") are kept as-is.
 * Returns "" for empty/missing versions.
 */
function formatVersionLabel(version) {
  if (version === null || version === undefined) return "";
  const text = String(version).trim();
  if (!text) return "";
  const bare = text.replace(/^v\s*(?=\d)/i, "");
  return /^\d/.test(bare) ? `v${bare}` : text;
}

/** Lowercased name without spaces/underscores/dashes, for loose comparisons. */
function looseName(name) {
  return String(name ?? "").toLowerCase().replace(/[\s_\-]+/g, "");
}

/**
 * True when the folder name adds information beyond the display title
 * (ignores case and _ / space / - differences).
 */
function folderDiffersFromTitle(folderName, title) {
  if (!folderName) return false;
  return looseName(folderName) !== looseName(title || folderName);
}

const RendererFormat = { formatVersionLabel, folderDiffersFromTitle, looseName };
if (typeof module !== "undefined" && module.exports) {
  module.exports = RendererFormat;
} else {
  globalThis.RendererFormat = RendererFormat;
}
})();
