const test = require("node:test");
const assert = require("node:assert/strict");
const { diffInstalled } = require("../lib/installState");
const { setPriorityInManifestText, validatePriority } = require("../lib/setModPriority");

test("diffInstalled reports added, removed and changed mods", () => {
  assert.deepEqual(diffInstalled({ A: "1", B: "2", C: "3" }, { A: "1", B: "x", D: "4" }), [
    { id: "B", kind: "changed" },
    { id: "C", kind: "removed" },
    { id: "D", kind: "added" },
  ]);
  assert.deepEqual(diffInstalled({ A: "1" }, { A: "1" }), []);
  assert.deepEqual(diffInstalled(null, { A: "1" }), [{ id: "A", kind: "added" }]);
});

test("setPriorityInManifestText edits the value in place", () => {
  const text = '{\r\n    "name": "X",\r\n    "priority": 5,\r\n    "nested": { "priority": 1 }\r\n}\r\n';
  const out = setPriorityInManifestText(text, 12);
  assert.equal(out, text.replace('"priority": 5', '"priority": 12'));
});

test("setPriorityInManifestText adds priority with the file's indentation", () => {
  const out = setPriorityInManifestText('{\n\t"name": "X"\n}\n', -3);
  assert.deepEqual(JSON.parse(out), { name: "X", priority: -3 });
  assert.match(out, /\n\t"priority": -3\n/);
  assert.ok(out.endsWith("}\n"));
});

test("validatePriority accepts integers only", () => {
  assert.equal(validatePriority(7), 7);
  assert.throws(() => validatePriority(1.5));
  assert.throws(() => validatePriority("abc"));
  assert.throws(() => validatePriority(Number.NaN));
});
