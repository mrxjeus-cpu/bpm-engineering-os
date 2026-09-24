import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo } from "./helpers/fixture.mjs";
import { McpClient } from "./helpers/mcp-client.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINEERING_ENTRY = path.join(REPO_ROOT, "mcp", "mcp-engineering", "dist", "index.js");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");

let fixture;
let client;

async function call(name, args = {}) {
  const result = await client.callTool(name, { project: "sample-fixture", ...args });
  assert.equal(result.isError, false, `tool ${name} lỗi: ${result.text.slice(0, 400)}`);
  return result.data;
}

before(async () => {
  fixture = makeFixtureRepo(FIXTURE_SOURCE);
  client = new McpClient({
    command: process.execPath,
    args: [ENGINEERING_ENTRY],
    cwd: REPO_ROOT,
    env: { SAMPLE_FIXTURE_REPO_ROOT: fixture.dir, ENG_INDEX_TTL_MS: "30000" },
  });
  await client.initialize();
});

after(() => {
  client?.close();
  fixture?.cleanup();
});

describe("symbol index — dựng, cache, tra cứu", () => {
  it("get_symbol_index trả thống kê thật của repo", async () => {
    const stats = await call("get_symbol_index", { force: true });
    assert.equal(stats.fromCache, false, "force=true phải dựng lại");
    assert.ok(stats.fileCount >= 5, `fileCount=${stats.fileCount}`);
    assert.ok(stats.symbolCount >= 10, `symbolCount=${stats.symbolCount}`);
    assert.match(stats.gitSha, /^[0-9a-f]{7,40}$/);
    assert.equal(stats.truncated, false);
    assert.match(stats.note, /KHÔNG phải type resolution/);
  });

  it("lần gọi sau dùng lại cache (index không dựng lại mỗi query)", async () => {
    const first = await call("get_symbol_index", { force: true });
    const second = await call("get_symbol_index");
    assert.equal(second.fromCache, true);
    assert.equal(second.builtAt, first.builtAt);
    assert.ok(second.ageMs >= 0);
  });

  it("TTL = 0 ⇒ luôn dựng lại (dùng khi cần index tươi)", async () => {
    const fresh = new McpClient({
      command: process.execPath,
      args: [ENGINEERING_ENTRY],
      cwd: REPO_ROOT,
      env: { SAMPLE_FIXTURE_REPO_ROOT: fixture.dir, ENG_INDEX_TTL_MS: "0" },
    });
    try {
      await fresh.initialize();
      const a = await fresh.callTool("get_symbol_index", { project: "sample-fixture" });
      const b = await fresh.callTool("get_symbol_index", { project: "sample-fixture" });
      assert.equal(a.data.fromCache, false);
      assert.equal(b.data.fromCache, false, "TTL=0 thì lần nào cũng phải dựng lại");
    } finally {
      fresh.close();
    }
  });

  it("find_symbol dùng index: có file + dòng + kind", async () => {
    const found = await call("find_symbol", { name: "PolicyInputMapper" });
    assert.equal(found.symbols.length >= 1, true);
    const hit = found.symbols[0];
    assert.match(hit.file, /PolicyInputMapper\.java$/);
    assert.equal(hit.kind, "type");
    assert.ok(hit.line > 0);
    assert.match(found.source, /symbol index/);
    assert.ok(found.index.symbols >= 10);
  });

  it("get_project_context có khối index", async () => {
    const context = await call("get_project_context");
    assert.ok(context.index, "phải có index stats");
    assert.ok(context.index.symbols >= 10);
    assert.ok(context.index.buildMs >= 0);
    assert.equal(typeof context.index.fromCache, "boolean");
  });
});

describe("symbol index — xếp hạng caller theo package/import", () => {
  it("caller cùng package được đánh 'likely' kèm lý do", async () => {
    const result = await call("find_callers", { symbol: "map" });
    assert.ok(result.callers.length >= 2, `callers=${JSON.stringify(result.callers)}`);
    assert.match(result.definition.file, /PolicyInputMapper\.java$/);
    for (const caller of result.callers) {
      assert.equal(caller.confidence, "likely");
      assert.match(caller.reason, /cùng package vn\.bpm\.domain\.policy/);
    }
    assert.match(result.source, /ranking theo package\/import/);
  });

  it("usage phân tầng: exact (file khai báo) → likely (có import) → weak (chỉ trùng tên)", async () => {
    const result = await call("find_references", { symbol: "getPurposeOfLoan" });
    const byConfidence = result.references.reduce((acc, ref) => {
      acc[ref.confidence] = (acc[ref.confidence] ?? 0) + 1;
      return acc;
    }, {});
    assert.ok(byConfidence.exact >= 1, JSON.stringify(result.references, null, 2));
    assert.ok(byConfidence.likely >= 2);
    assert.ok(byConfidence.weak >= 1, "method trùng tên ở class khác phải bị đánh weak");

    // thứ tự: exact trước, weak sau
    const order = { exact: 0, likely: 1, weak: 2 };
    for (let i = 1; i < result.references.length; i += 1) {
      assert.ok(
        order[result.references[i - 1].confidence] <= order[result.references[i].confidence],
        `sai thứ tự tại ${i}: ${JSON.stringify(result.references.map((r) => r.confidence))}`,
      );
    }

    const weak = result.references.find((ref) => ref.confidence === "weak");
    assert.match(weak.file, /PolicyInput\.java$/, "hit 'weak' là declaration trùng tên ở class khác");
    assert.match(weak.reason, /chỉ trùng tên/);
    assert.match(result.note, /phải xác nhận/);
  });

  it("get_change_context dùng index và tách strong/weak caller", async () => {
    const context = await call("get_change_context", {
      file: "src/main/java/vn/bpm/domain/policy/PolicyInputMapper.java",
      symbol: "map",
    });
    assert.match(context.definition.body, /setPurposeOfLoan/);
    assert.ok(context.callers.length >= 2);
    assert.equal(context.strongCallers, context.callers.filter((caller) => caller.confidence !== "weak").length);
    assert.ok(context.strongCallers >= 2);
    assert.ok(context.index.symbols >= 10);
    assert.match(context.note, /type resolution/);
  });

  it("read_symbol định vị bằng index (không quét cả repo)", async () => {
    const symbol = await call("read_symbol", { symbol: "checkPolicy" });
    assert.match(symbol.file, /PolicyService\.java$/);
    assert.match(symbol.body, /checkPolicy/);
    assert.match(symbol.source, /symbol index/);
    assert.ok(symbol.endLine >= symbol.startLine);
  });
});
