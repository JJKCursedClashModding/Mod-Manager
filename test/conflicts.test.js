const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getConflicts } = require("../lib/conflicts");
const { mergeDatatableRows } = require("../lib/packageAllMods");

/** Creates mods in a temp dir: spec = { id: { priority, tables: { Table: rows } } }. */
function makeMods(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jjkmm-conflicts-test-"));
  const mods = [];
  for (const [id, { priority = 0, tables = {}, params = {} }] of Object.entries(spec)) {
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, "datatables"), { recursive: true });
    for (const [table, rows] of Object.entries(tables)) {
      fs.writeFileSync(path.join(dir, "datatables", `${table}.json`), JSON.stringify(rows));
    }
    if (Object.keys(params).length) {
      fs.mkdirSync(path.join(dir, "parameters"), { recursive: true });
      for (const [shortName, rows] of Object.entries(params)) {
        fs.writeFileSync(path.join(dir, "parameters", `${shortName}.json`), JSON.stringify(rows));
      }
    }
    mods.push({ id, title: id, priority, fullPath: dir, enabled: true });
  }
  return { root, mods };
}

/** What the build would write for a table, merging in packageAllMods' order. */
function buildMerge(mods, spec, table) {
  const order = [...mods].sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id)));
  return mergeDatatableRows(
    order.filter((m) => spec[m.id].tables?.[table]).map((m) => ({ source: m.id, rows: spec[m.id].tables[table] })),
  ).combined;
}

async function withMods(spec, fn) {
  const { root, mods } = makeMods(spec);
  try {
    return await fn(mods, await getConflicts(mods, { rescan: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("disjoint fields on a shared row merge cleanly (no conflict)", async () => {
  await withMods(
    {
      A: { tables: { AttackDataTable: { Row1: { Damage: 10 } } } },
      B: { tables: { AttackDataTable: { row1: { Speed: 2 } } } },
    },
    (_mods, res) => {
      assert.equal(res.total, 0);
      assert.equal(res.cleanSharedRows, 1);
    },
  );
});

test("identical values on the same field are not a conflict", async () => {
  await withMods(
    {
      A: { tables: { T: { R: { F: { x: 1, y: [1, 2] } } } } },
      B: { tables: { T: { R: { f: { x: 1, y: [1, 2] } } } } },
    },
    (_mods, res) => {
      assert.equal(res.total, 0);
      assert.equal(res.cleanSharedRows, 1);
    },
  );
});

test("new rows from several mods are never conflicts", async () => {
  await withMods(
    {
      A: { tables: { T: { NewRowA: { F: 1 } } } },
      B: { tables: { T: { NewRowB: { F: 2 } } } },
    },
    (_mods, res) => {
      assert.equal(res.total, 0);
      assert.equal(res.cleanSharedRows, 0);
    },
  );
});

test("different values on the same field: winner is the higher priority, matching the build merge", async () => {
  const spec = {
    Low: { priority: 5, tables: { T: { R: { F: 1, Other: 1 } } } },
    High: { priority: 10, tables: { T: { r: { f: 2 } } } },
  };
  await withMods(spec, (mods, res) => {
    assert.equal(res.total, 1);
    const c = res.conflicts[0];
    assert.equal(c.type, "datatable");
    assert.equal(c.winnerId, "High");
    assert.equal(c.tie, false);
    assert.deepEqual(
      c.mods.map((m) => m.id),
      ["Low", "High"],
    );
    const merged = buildMerge(mods, spec, "T");
    assert.equal(merged.r.f, 2); // build agrees: High's value lands
    assert.equal(merged.r.Other, 1);
    assert.equal(res.byMod.High.wins, 1);
    assert.equal(res.byMod.Low.overridden, 1);
  });
});

test("equal priority: the folder name sorting last wins, flagged as a tie", async () => {
  const spec = {
    Bravo: { priority: 0, tables: { T: { R: { F: "bravo" } } } },
    Alpha: { priority: 0, tables: { T: { R: { F: "alpha" } } } },
  };
  await withMods(spec, (mods, res) => {
    assert.equal(res.total, 1);
    const c = res.conflicts[0];
    assert.equal(c.winnerId, "Bravo");
    assert.equal(c.tie, true);
    assert.equal(buildMerge(mods, spec, "T").R.F, "bravo");
  });
});

test("only the differing field of a shared row is reported", async () => {
  await withMods(
    {
      A: { priority: 1, tables: { T: { R: { Same: 1, Diff: 1, OnlyA: 1 } } } },
      B: { priority: 2, tables: { T: { R: { Same: 1, Diff: 2, OnlyB: 1 } } } },
    },
    (_mods, res) => {
      assert.equal(res.total, 1);
      assert.equal(res.conflicts[0].field, "Diff");
      assert.equal(res.cleanSharedRows, 0);
    },
  );
});

test("parameter rows conflict only on different values", async () => {
  await withMods(
    {
      A: { priority: 1, params: { Shared: { Row: { v: 1 } } } },
      B: { priority: 2, params: { Shared: { Row: { v: 1 } } } },
    },
    (_mods, res) => assert.equal(res.total, 0),
  );
  await withMods(
    {
      A: { priority: 1, params: { Shared: { Row: { v: 1 } } } },
      B: { priority: 2, params: { Shared: { Row: { v: 2 } } } },
    },
    (_mods, res) => {
      assert.equal(res.total, 1);
      assert.equal(res.conflicts[0].type, "parameter");
      assert.equal(res.conflicts[0].winnerId, "B");
    },
  );
});
