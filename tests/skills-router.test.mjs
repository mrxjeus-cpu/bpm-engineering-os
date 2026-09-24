import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENT_ROLES,
  loadSkills,
  renderAgentPrompt,
  renderSkillsSection,
  routeSkills,
  skillCatalogSummary,
  skillsRoot,
  splitFrontMatter,
  workstreamDir,
} from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");

const S = "SK-0100";
const ALL = [S];

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("skill catalog", () => {
  it("đọc được toàn bộ skill và KHÔNG có lỗi cấu trúc", () => {
    const catalog = loadSkills();
    assert.ok(catalog.skills.length >= 17, `chỉ thấy ${catalog.skills.length} skill`);
    assert.deepEqual(catalog.issues, [], `lỗi: ${JSON.stringify(catalog.issues, null, 2)}`);
  });

  it("mỗi skill có name khớp thư mục, phase/roles hợp lệ, và đủ 4 section", () => {
    const catalog = loadSkills();
    for (const skill of catalog.skills) {
      assert.ok(skill.description.startsWith("Use when"), `${skill.name}: description không bắt đầu bằng "Use when"`);
      assert.ok(!/\bthen\b|→|->/i.test(skill.description), `${skill.name}: description mô tả workflow`);
      for (const section of ["## WHEN", "## DO", "## MUST OUTPUT", "## MUST NOT"]) {
        assert.ok(skill.body.includes(section), `${skill.name}: thiếu ${section}`);
      }
      assert.ok(skill.phase && skill.phase.length > 0, `${skill.name}: thiếu phase`);
      if (skill.roles) {
        for (const role of skill.roles) {
          assert.ok(AGENT_ROLES.includes(role), `${skill.name}: role lạ "${role}"`);
        }
      }
      assert.ok(skill.body.split("\n").length <= 300, `${skill.name}: quá dài (INV-09)`);
    }
  });

  it("phát hiện skill lỗi: description mô tả workflow + thiếu section (dùng fixture tạm)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "domain-skills-"));
    try {
      mkdirSync(path.join(dir, "bad"), { recursive: true });
      writeFileSync(
        path.join(dir, "bad", "SKILL.md"),
        [
          "---",
          "name: bad",
          "description: Use when X, then do step 1 and step 2 → done",
          "phase: [implementation]",
          "---",
          "",
          "## WHEN",
          "- x",
        ].join("\n"),
        "utf8",
      );
      const catalog = loadSkills(dir);
      const codes = catalog.issues.map((issue) => issue.code).sort();
      assert.ok(codes.includes("DESCRIPTION_SUMMARIZES_WORKFLOW"), `codes=${codes.join(",")}`);
      assert.ok(codes.includes("MISSING_SECTIONS"), `codes=${codes.join(",")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splitFrontMatter tách đúng meta và body", () => {
    const { meta, body } = splitFrontMatter("---\nname: x\ndescription: Use when y\n---\n\n## WHEN\n- a\n");
    assert.equal(meta.name, "x");
    assert.match(body, /## WHEN/);
    assert.ok(!body.includes("---"));
  });

  it("summary nhóm skill theo group cho CLI", () => {
    const summary = skillCatalogSummary(loadSkills());
    assert.equal(summary.valid, true);
    const byGroup = summary.byGroup;
    assert.ok(byGroup.meta.length >= 5);
    assert.ok(byGroup.engineering.length >= 9);
    assert.ok(byGroup.domain.length >= 3);
  });
});

describe("skill router (progressive disclosure)", () => {
  const catalog = loadSkills();

  it("developer/implementation luôn có skill bắt buộc implementation + tdd + verification", () => {
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "Sửa gì đó" }, catalog);
    const names = route.selected.map((entry) => entry.skill.name);
    for (const required of ["implementation", "tdd", "verification"]) {
      assert.ok(names.includes(required), `thiếu skill bắt buộc ${required}: ${names.join(", ")}`);
    }
    assert.deepEqual(route.requiredDropped, []);
  });

  it("skill của role KHÁC không lọt vào prompt chỉ vì trùng từ", () => {
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "policy rule TD1" }, catalog);
    const names = route.selected.map((entry) => entry.skill.name);
    assert.ok(!names.includes("architecture-review"), `architecture-review lọt vào: ${names.join(", ")}`);
    assert.ok(!names.includes("code-review"), `code-review lọt vào: ${names.join(", ")}`);
    assert.ok(!names.includes("audit"), `audit lọt vào: ${names.join(", ")}`);
  });

  it("trigger trong objective kéo đúng skill domain lên", () => {
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "Cập nhật policy TD1 cho POLICY-NHADAT" }, catalog);
    const names = route.selected.map((entry) => entry.skill.name);
    assert.ok(names.includes("policy-analysis"), names.join(", "));
    const entry = route.selected.find((item) => item.skill.name === "policy-analysis");
    assert.ok(entry.reasons.some((reason) => reason.startsWith("trigger=")));
    assert.ok(entry.score >= 8);
  });

  it("bug/regression kéo skill systematic-debugging", () => {
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "Test fail sau khi sửa" }, catalog);
    assert.ok(route.selected.some((entry) => entry.skill.name === "systematic-debugging"));
  });

  it("reviewer/audit nhận đúng skill theo vai trò", () => {
    const reviewer = routeSkills({ role: "reviewer", phase: "review", objective: "review diff" }, catalog);
    assert.deepEqual(
      reviewer.selected.map((entry) => entry.skill.name).sort(),
      ["code-review", "recovery", "systematic-debugging", "verification"],
    );
    const auditor = routeSkills({ role: "auditor", phase: "audit", objective: "" }, catalog);
    assert.ok(auditor.selected.some((entry) => entry.skill.name === "audit"));
  });

  it("cắt theo budget token và báo tokenLimited", () => {
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "policy TD1" }, catalog);
    const tight = routeSkills(
      { role: "developer", phase: "implementation", objective: "policy TD1", maxTokens: 400 },
      catalog,
    );
    assert.ok(tight.tokens <= 400, `tokens=${tight.tokens}`);
    assert.ok(tight.selected.length < route.selected.length);
    assert.equal(tight.tokenLimited, true);
    assert.ok(tight.requiredDropped.length > 0, "phải báo rõ skill bắt buộc bị cắt");
  });

  it("renderSkillsSection chỉ chứa skill được chọn", () => {
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "policy TD1" }, catalog);
    const section = renderSkillsSection(route.selected);
    for (const entry of route.selected) assert.ok(section.includes(entry.skill.name));
    assert.ok(!section.includes("requirements-analysis"));
  });
});

describe("prompt contract có SKILLS + OUTPUT FORMAT", () => {
  before(async () => {
    cleanup();
    await runCli(["new", S, "--title", "Thêm Purpose of Loan vào policy input", "--risk", "HIGH"]);
    await runCli(["plan", "import", S, "--file", path.join(REPO_ROOT, "tests", "fixtures", "plans", "valid-plan.md")]);
    const compiled = await runCli(["context", S, "TASK-03", "--no-mcp"]);
    assert.equal(compiled.code, 0, compiled.stderr);
  });

  after(cleanup);

  it("dry run nhúng skill theo phase + template output", async () => {
    const result = await runCli(["agent", "developer", S, "TASK-03", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout);
    const names = parsed.skills.map((skill) => skill.name);
    assert.ok(names.includes("implementation"));
    assert.ok(names.includes("tdd"));
    assert.ok(names.includes("verification"));
    assert.ok(parsed.skillTokens > 500, `skillTokens=${parsed.skillTokens}`);
    assert.deepEqual(parsed.templates, ["templates/task-report.md"]);

    const prompt = readFileSync(path.join(workstreamDir(S), parsed.promptPath), "utf8");
    assert.match(prompt, /SKILLS \(HOW — bắt buộc tuân theo\)/);
    assert.match(prompt, /--- skill: tdd/);
    assert.match(prompt, /OUTPUT FORMAT \(theo template\)/);
    assert.match(prompt, /# Report — TASK-NN/);
    // thứ tự section: SKILLS trước EXPECTED OUTPUT, template nằm trong EXPECTED OUTPUT
    assert.ok(prompt.indexOf("SKILLS (HOW") < prompt.indexOf("EXPECTED OUTPUT"));
    assert.ok(prompt.indexOf("OUTPUT FORMAT") > prompt.indexOf("EXPECTED OUTPUT"));
  });

  it("prompt có thêm chỉ dẫn riêng từ agents/<role>.md", async () => {
    const result = await runCli(["agent", "developer", S, "TASK-03", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout);
    const prompt = readFileSync(path.join(workstreamDir(S), parsed.promptPath), "utf8");
    assert.match(prompt, /ADDITIONAL INSTRUCTIONS \(từ agents\/<role>\.md\)/);
    assert.match(prompt, /Dừng và báo BLOCKED khi/);
  });

  it("prompt vẫn KHÔNG nhúng nội dung context (INV-01)", async () => {
    const result = await runCli(["agent", "developer", S, "TASK-03", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout);
    const prompt = readFileSync(path.join(workstreamDir(S), parsed.promptPath), "utf8");
    assert.match(prompt, /context\/TASK-03\.md/);
    assert.ok(!prompt.includes("## Unknowns"), "không được nhúng cả file context");
  });

  it("--no-skills cho prompt tối giản để so sánh", async () => {
    const withSkills = await runCli(["agent", "developer", S, "TASK-03", "--dry-run", "--json"]);
    const rich = JSON.parse(withSkills.stdout);
    assert.ok(rich.skills.length > 0);
    assert.ok(rich.skillTokens > 500);

    const plain = await runCli(["agent", "developer", S, "TASK-03", "--dry-run", "--no-skills", "--json"]);
    const minimal = JSON.parse(plain.stdout);
    assert.deepEqual(minimal.skills, []);
    assert.equal(minimal.skillTokens, 0);

    const prompt = readFileSync(path.join(workstreamDir(S), minimal.promptPath), "utf8");
    assert.ok(!prompt.includes("SKILLS (HOW"), "prompt --no-skills không được có section SKILLS");
  });

  it("eng skills CLI: list + show + route", async () => {
    const list = await runCli(["skills"]);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /skills: \d+/);

    const show = await runCli(["skills", "show", "verification"]);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /## MUST NOT/);
    assert.match(show.stdout, /bằng chứng mới|provenance/);

    const route = await runCli(["skills", "route", "developer", "--phase", "implementation", "--json"]);
    const parsed = JSON.parse(route.stdout);
    assert.ok(parsed.selected.some((entry) => entry.name === "implementation"));
    assert.ok(parsed.selected.every((entry) => entry.score > 0));

    const missing = await runCli(["skills", "show", "khong-co-skill"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /SKILL_NOT_FOUND/);
  });

  it("skillsRoot trỏ đúng thư mục skills/", () => {
    assert.equal(skillsRoot(), path.join(REPO_ROOT, "skills"));
  });

  it("renderAgentPrompt chèn SKILLS đúng vị trí (giữa CONSTRAINTS và EXPECTED OUTPUT)", () => {
    const catalog = loadSkills();
    const route = routeSkills({ role: "developer", phase: "implementation", objective: "policy" }, catalog);
    const prompt = renderAgentPrompt({
      contract: { role: "developer", title: "t", rolePrompt: "r", inputs: [], outputs: [], expectedOutput: ["out"], doNot: ["x"] },
      taskId: "SK-9999",
      subTaskId: "TASK-01",
      objective: "o",
      constraints: ["c"],
      verification: ["v"],
      acceptanceCriteriaCount: 1,
      inputs: [],
      tier: "medium",
      tierReason: "test",
      skills: route.selected.map((entry) => ({ name: entry.skill.name, file: entry.skill.file, reasons: entry.reasons, body: entry.skill.body })),
      templates: [{ name: "task-report.md", path: "templates/task-report.md", content: "# Report" }],
    });
    const order = ["CONSTRAINTS", "SKILLS (HOW", "EXPECTED OUTPUT", "OUTPUT FORMAT", "VERIFICATION", "DO NOT"];
    let cursor = -1;
    for (const section of order) {
      const index = prompt.indexOf(section);
      assert.ok(index > cursor, `sai thứ tự tại ${section}`);
      cursor = index;
    }
  });
});
