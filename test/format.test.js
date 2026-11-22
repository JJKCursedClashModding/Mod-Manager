const test = require("node:test");
const assert = require("node:assert/strict");
const { formatVersionLabel, folderDiffersFromTitle } = require("../renderer/format");

test("formatVersionLabel never doubles the v prefix", () => {
  assert.equal(formatVersionLabel("3"), "v3");
  assert.equal(formatVersionLabel("v3"), "v3");
  assert.equal(formatVersionLabel("V1.2.0"), "v1.2.0");
  assert.equal(formatVersionLabel(" v 4 "), "v4");
  assert.equal(formatVersionLabel(2), "v2");
  assert.equal(formatVersionLabel(0), "v0");
});

test("formatVersionLabel keeps non-numeric versions and drops empty ones", () => {
  assert.equal(formatVersionLabel("beta"), "beta");
  assert.equal(formatVersionLabel("vintage"), "vintage");
  assert.equal(formatVersionLabel(""), "");
  assert.equal(formatVersionLabel("   "), "");
  assert.equal(formatVersionLabel(null), "");
  assert.equal(formatVersionLabel(undefined), "");
});

test("folderDiffersFromTitle ignores case, spaces, underscores and dashes", () => {
  assert.equal(folderDiffersFromTitle("Better_Gameplay", "Better Gameplay"), false);
  assert.equal(folderDiffersFromTitle("better-gameplay", "Better Gameplay"), false);
  assert.equal(folderDiffersFromTitle("SXD_1Playtest_T24Miwaso", "Miwa Rework"), true);
  assert.equal(folderDiffersFromTitle("Foo", ""), false);
  assert.equal(folderDiffersFromTitle("", "Foo"), false);
});
