import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AGENTS, AGENT_ROLES } from "../agents/registry.js";
import {
  type HarnessSpec,
  harnessNames,
  harnessSpec,
  loadConfig,
  projectConfig,
  resolveRepoRoot,
} from "../config/index.js";
import { OS_ROOT, osPath } from "../paths.js";
import { resolveModelDecision } from "../router/model.js";
import { loadSkills } from "../skills/loader.js";
import { TRANSITIONS } from "../state/machine.js";
import { canTransition } from "../state/machine.js";
import { workstreamRoot } from "../config/index.js";
import type { TaskStatus } from "../types.js";
import { RISK_LEVELS, type DoctorCheck } from "./types.js";

const execFileAsync = promisify(execFile);

const MCP_GROUPS: Record<string, string[]> = {
  "mcp-engineering": ["context", "code", "architecture", "git", "verification", "task"],
  "mcp-domain-core": ["product", "policy", "fact", "core", "reference"],
};

const PHASES = [
  "translate",
  "requirements",
  "impact",
  "architecture",
  "planning",
  "implementation",
  "review",
  "audit",
  "verification",
];

export function checkNode(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 22) {
    return { id: "node", title: "Node ≥ 22", level: "ok", detail: `node ${process.versions.node} (${process.platform})` };
  }
  return {
    id: "node",
    title: "Node ≥ 22",
    level: "fail",
    detail: `node ${process.versions.node} — repo yêu cầu >=22 (ESM, node:test, fs.glob).`,
    hint: "Nâng Node lên 22 LTS rồi chạy lại: nvm install 22 && nvm use 22",
  };
}

export function checkOsRoot(): DoctorCheck {
  const required = ["config", "schemas", "skills", "runtime", "mcp"].filter((dir) => !existsSync(osPath(dir)));
  if (required.length > 0) {
    return {
      id: "os-root",
      title: "Cây thư mục Engineering OS",
      level: "fail",
      detail: `thiếu: ${required.join(", ")} trong ${OS_ROOT}`,
      hint: "ENGINEERING_OS_ROOT trỏ sai, hoặc repo chưa clone đủ. Kiểm tra biến môi trường và chạy lại.",
      details: { osRoot: OS_ROOT },
    };
  }
  // .engineering/ phải ghi được — state/evidence đều nằm ở đây (INV-02).
  try {
    const root = workstreamRoot();
    mkdirSync(root, { recursive: true });
    const probe = path.join(root, ".doctor-probe");
    writeFileSync(probe, "probe", "utf8");
    rmSync(probe, { force: true });
    return { id: "os-root", title: "Cây thư mục Engineering OS + workstream ghi được", level: "ok", detail: `${OS_ROOT} · workstream ${root}` };
  } catch (error) {
    return {
      id: "os-root",
      title: "Cây thư mục Engineering OS + workstream ghi được",
      level: "fail",
      detail: `${OS_ROOT} có đủ thư mục nhưng KHÔNG ghi được ${workstreamRoot()}: ${String(error)}`,
      hint: "Sửa quyền thư mục hoặc đặt .engineering/ trong ổ đĩa ghi được (Windows: tránh ổ chỉ đọc/OneDrive sync).",
    };
  }
}

export function checkConfig(): DoctorCheck {
  const config = loadConfig();
  const harnesses = harnessNames();
  return {
    id: "config",
    title: "5 file config hợp lệ",
    level: "ok",
    detail:
      `models(${Object.keys(config.models.tiers).length} tier, ${harnesses.length} harness) · ` +
      `gates(${config.gates.gates.length} gate, defaultMode=${config.gates.defaultMode}) · ` +
      `risk(${config.risk.factors.length} factor) · mcp(${Object.keys(config.mcp.servers).length} server) · ` +
      `projects(${Object.keys(config.projects.projects).length}, default=${config.projects.defaultProject})`,
  };
}

/** Bắt đúng lớp lỗi đã xảy ra: gate gắn vào transition không tồn tại trong state machine. */
export function checkGates(): DoctorCheck {
  const config = loadConfig();
  const bad: string[] = [];
  for (const gate of config.gates.gates) {
    const [from, to] = gate.transition;
    if (from === "*" || to === "*") continue;
    if (!(from in TRANSITIONS)) bad.push(`${gate.id}: status "${from}" không tồn tại`);
    else if (!canTransition(from as TaskStatus, to as TaskStatus)) {
      bad.push(`${gate.id}: ${from} → ${to} không có trong state machine (chỉ có: ${(TRANSITIONS[from as TaskStatus] ?? []).join(", ") || "không có"})`);
    }
  }
  const gateIds = new Set(config.gates.gates.map((gate) => gate.id));
  for (const mode of Object.keys(config.gates.modes)) {
    const modeConfig = config.gates.modes[mode as keyof typeof config.gates.modes];
    for (const gateId of modeConfig.humanGates) {
      if (!gateIds.has(gateId)) bad.push(`mode ${mode} tham chiếu gate không tồn tại: ${gateId}`);
    }
  }
  if (bad.length > 0) {
    return {
      id: "gates",
      title: "Human gate khớp state machine",
      level: "fail",
      detail: bad.join(" · "),
      hint: "Sửa config/gates.yaml cho khớp TRANSITIONS trong runtime/src/state/machine.ts (spec mục 8.1). Gate trên transition không tồn tại sẽ KHÔNG bao giờ chạy.",
    };
  }
  const required = config.gates.gates.filter((gate) => gate.required).map((gate) => gate.id);
  return {
    id: "gates",
    title: "Human gate khớp state machine",
    level: "ok",
    detail: `${config.gates.gates.length} gate, hợp lệ · bắt buộc: ${required.join(", ") || "—"}`,
  };
}

export function checkRisk(): DoctorCheck {
  const config = loadConfig();
  const missing = RISK_LEVELS.filter((level) => !(level in config.risk.effects));
  if (missing.length > 0) {
    return {
      id: "risk",
      title: "Risk scale + effects đủ 4 mức",
      level: "fail",
      detail: `effects thiếu mức: ${missing.join(", ")}`,
      hint: "Thêm effects cho từng mức trong config/risk.yaml — risk CRITICAL mà không có effect nghĩa là gate cuối không được thêm (RULES-001).",
    };
  }
  return {
    id: "risk",
    title: "Risk scale + effects đủ 4 mức",
    level: "ok",
    detail: `scale ${config.risk.scale.join(" < ")} · ${Object.keys(config.risk.effects).length} effects`,
  };
}

/** Mọi agent × mọi risk phải resolve ra tier có thật trong config/models.yaml. */
export function checkModels(): DoctorCheck[] {
  const config = loadConfig();
  const tiers = Object.keys(config.models.tiers);
  const checks: DoctorCheck[] = [];
  const unresolved: string[] = [];
  const used = new Set<string>();
  for (const role of AGENT_ROLES) {
    for (const risk of RISK_LEVELS) {
      try {
        const decision = resolveModelDecision({ role, risk, files: 0, dependencies: 0 });
        used.add(decision.tier);
        if (!tiers.includes(decision.tier)) unresolved.push(`${role}/${risk} → tier "${decision.tier}" không có trong tiers`);
      } catch (error) {
        unresolved.push(`${role}/${risk} → lỗi resolve: ${String(error)}`);
      }
    }
  }
  if (unresolved.length > 0) {
    checks.push({
      id: "models-route",
      title: "Model routing resolve cho mọi agent × risk",
      level: "fail",
      detail: unresolved.slice(0, 6).join(" · "),
      hint: "Kiểm tra config/models.yaml: tiers, agents, riskFloor, routing.caps (fallback/minTier/maxTier phải nằm trong tiers).",
    });
  } else {
    checks.push({
      id: "models-route",
      title: "Model routing resolve cho mọi agent × risk",
      level: "ok",
      detail: `${AGENT_ROLES.length} agent × ${RISK_LEVELS.length} risk ⇒ tier dùng: ${[...used].sort().join(", ")}`,
    });
  }

  const missingFloor = RISK_LEVELS.filter((level) => !(level in config.models.riskFloor));
  const rolesWithoutTier = AGENT_ROLES.filter((role) => !(role in config.models.agents));
  const problems = [
    ...(missingFloor.length > 0 ? [`riskFloor thiếu: ${missingFloor.join(", ")}`] : []),
    ...(rolesWithoutTier.length > 0 ? [`agents thiếu: ${rolesWithoutTier.join(", ")}`] : []),
  ];
  checks.push(
    problems.length > 0
      ? {
          id: "models-map",
          title: "Bảng agents / riskFloor đủ",
          level: "fail",
          detail: problems.join(" · "),
          hint: `Thêm vào config/models.yaml. Agent registry có: ${Object.keys(AGENTS).join(", ")}`,
        }
      : {
          id: "models-map",
          title: "Bảng agents / riskFloor đủ",
          level: "ok",
          detail: `${Object.keys(config.models.agents).length} agent · riskFloor ${RISK_LEVELS.map((level) => `${level}→${config.models.riskFloor[level]}`).join(" ")}`,
        },
  );
  return checks;
}

/**
 * So hai đường dẫn có trỏ cùng chỗ không. Cần thiết vì macOS có /var → /private/var và Windows
 * có tên 8.3/ổ đĩa khác case; so chuỗi thô sẽ báo sai "repoRoot là thư mục con".
 */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const cleaned = value.replace(/\\/g, "/").replace(/\/+$/, "");
    try {
      return realpathSync.native(cleaned).replace(/\\/g, "/").replace(/\/+$/, "");
    } catch {
      return cleaned;
    }
  };
  const left = normalize(a);
  const right = normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Tìm binary trên PATH (Windows cần PATHEXT) — không thực thi để tránh side effect. */
export function resolveBinary(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null;
  }
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      if (ext !== ext.toLowerCase()) {
        const upper = path.join(dir, `${command}${ext}`);
        if (existsSync(upper)) return upper;
      }
    }
  }
  return null;
}

export function checkHarness(): DoctorCheck {
  const names = harnessNames();
  const enabled: Array<{ name: string; spec: HarnessSpec }> = [];
  for (const name of names) {
    const spec = harnessSpec(name);
    if (spec?.enabled === true) enabled.push({ name, spec });
  }
  if (enabled.length === 0) {
    return {
      id: "harness",
      title: "Có harness agent được bật (INV-07)",
      level: "warn",
      detail: `config/models.yaml có ${names.length} harness nhưng KHÔNG cái nào enabled ⇒ chỉ chạy được --dry-run/--harness dry.`,
      hint: "Bật harness thật cho môi trường nội bộ: harness.<tên>.enabled = true + command gọi CLI LLM của bạn; giữ runtime không hard-code provider.",
      details: { harnesses: names },
    };
  }

  const broken: string[] = [];
  const resolvable: string[] = [];
  for (const { name, spec } of enabled) {
    const binary = spec.command[0] ?? "";
    const resolved = resolveBinary(binary);
    if (resolved === null) broken.push(`${name}: không tìm thấy "${binary}" trên PATH`);
    else resolvable.push(`${name}→${binary}`);
    const cwd = spec.cwd ?? "{osRoot}";
    if (cwd.includes("{repoRoot}")) {
      // cần project mới kiểm được — checkProjects sẽ báo nếu thiếu env
      continue;
    }
    const dir = cwd.replaceAll("{osRoot}", OS_ROOT).replaceAll("{taskId}", "").replaceAll("{subTaskId}", "");
    if (!existsSync(dir)) broken.push(`${name}: cwd không tồn tại: ${dir}`);
  }
  if (broken.length > 0) {
    return {
      id: "harness",
      title: "Harness agent bật được + binary tồn tại",
      level: "fail",
      detail: broken.join(" · "),
      hint: "Sửa cwd/command trong config/models.yaml. Binary phải gọi được từ chính máy này (kiểm tra PATH trong cùng shell chạy eng).",
    };
  }
  return {
    id: "harness",
    title: "Harness agent bật được + binary tồn tại",
    level: "ok",
    detail: `enabled: ${resolvable.join(", ")}${names.length > enabled.length ? ` (${names.length - enabled.length} harness tắt)` : ""}`,
  };
}

export function checkMcp(): DoctorCheck {
  const config = loadConfig();
  const problems: string[] = [];
  const notes: string[] = [];
  for (const [name, server] of Object.entries(config.mcp.servers)) {
    const known = MCP_GROUPS[name];
    if (known === undefined) {
      problems.push(`${name}: server không có trong runtime (chỉ có ${Object.keys(MCP_GROUPS).join(", ")})`);
      continue;
    }
    // Server tạm dừng (enabled: false): không bắt build/group — chỉ ghi chú trạng thái.
    if (server.enabled === false) {
      notes.push(`${name}: ĐANG TẮT (enabled: false trong config/mcp.yaml) — bật lại bằng enabled: true`);
      continue;
    }
    const groups = Object.keys(server.groups ?? {});
    const unknownGroups = groups.filter((group) => !known.includes(group));
    if (unknownGroups.length > 0) problems.push(`${name}: group lạ ${unknownGroups.join(", ")} (chỉ có ${known.join(", ")})`);
    const off = groups.filter((group) => server.groups?.[group] !== true);
    if (off.length > 0) notes.push(`${name}: tắt ${off.join(", ")}`);
    const entry = path.join(OS_ROOT, ...(server.args ?? []));
    if (!existsSync(entry)) problems.push(`${name}: chưa build (thiếu ${path.relative(OS_ROOT, entry)})`);
  }

  for (const phase of PHASES) {
    const servers = config.mcp.routing.byPhase[phase];
    if (servers === undefined) problems.push(`routing.byPhase thiếu phase "${phase}"`);
    else for (const server of servers) {
      if (!(server in config.mcp.servers)) problems.push(`routing.byPhase.${phase} trỏ tới server chưa khai báo: ${server}`);
      else if (config.mcp.servers[server]?.enabled === false) {
        const note = `${server}: ĐANG TẮT nhưng routing.byPhase.${phase} vẫn trỏ tới — bỏ qua (routing không được thực thi)`;
        if (!notes.includes(note)) notes.push(note);
      }
    }
  }
  const byDomain = Object.entries(config.mcp.routing.byDomain);
  for (const [domain, servers] of byDomain) {
    for (const server of servers) {
      // mcp-card/mcp-deposit là cấu hình trước cho Phase 2 — chỉ ghi chú, không phải lỗi.
      if (!(server in config.mcp.servers) && !notes.some((note) => note.includes(server))) {
        notes.push(`byDomain.${domain} → ${server}: chưa tồn tại (Phase 2)`);
      }
    }
  }

  if (problems.length > 0) {
    return {
      id: "mcp",
      title: "MCP server + group + routing (INV-10)",
      level: "fail",
      detail: problems.join(" · "),
      hint: "Chạy `npm run build` để build 2 MCP server, và giữ tên group khớp tools.ts của từng server.",
    };
  }
  return {
    id: "mcp",
    title: "MCP server + group + routing (INV-10)",
    level: "ok",
    detail: `${Object.keys(config.mcp.servers).length} server build sẵn · routing đủ ${PHASES.length} phase${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}`,
    details: { notes },
  };
}

export function checkSkills(): DoctorCheck {
  const catalog = loadSkills();
  const structural = catalog.issues.filter((issue) => issue.code !== "TOO_LONG");
  const tooLong = catalog.issues.filter((issue) => issue.code === "TOO_LONG");
  if (structural.length > 0) {
    return {
      id: "skills",
      title: "Skill catalog hợp lệ (INV-09)",
      level: "fail",
      detail: `${structural.length} lỗi: ${structural.slice(0, 4).map((issue) => `${issue.file} [${issue.code}]`).join(" · ")}`,
      hint: "Sửa front-matter/section của skill: description chỉ nêu WHEN, không tóm tắt workflow (ADR-07).",
    };
  }
  const base = { id: "skills", title: "Skill catalog hợp lệ (INV-09)", details: { skills: catalog.skills.length, groups: [...new Set(catalog.skills.map((skill) => skill.group))] } };
  if (tooLong.length > 0) {
    return { ...base, level: "warn", detail: `${catalog.skills.length} skill · ${tooLong.length} skill quá dài (>300 dòng, INV-09)`, hint: "Tách skill dài thành nhiều skill nhỏ — skill dài bị đọc hết vào context." };
  }
  return { ...base, level: "ok", detail: `${catalog.skills.length} skill hợp lệ, không có lỗi cấu trúc` };
}

export function checkGit(): Promise<DoctorCheck> {
  return execFileAsync("git", ["--version"], { timeout: 15_000 })
    .then(({ stdout }) => ({
      id: "git",
      title: "git dùng được (worktree, scope validation)",
      level: "ok" as const,
      detail: stdout.trim(),
    }))
    .catch((error: unknown) => ({
      id: "git",
      title: "git dùng được (worktree, scope validation)",
      level: "fail" as const,
      detail: `không chạy được "git --version": ${String(error)}`,
      hint: "Cài git và thêm vào PATH — validate_scope, merge và wave song song đều cần git.",
    }));
}

interface GitInfo {
  isRepo: boolean;
  branch?: string;
  dirty?: boolean;
  /** Gốc repo thật — có thể là thư mục CHA nếu repoRoot là thư mục con của một repo lớn hơn. */
  toplevel?: string;
}

async function gitInfo(dir: string): Promise<GitInfo> {
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "--git-dir"], { timeout: 15_000 });
  } catch {
    return { isRepo: false };
  }
  const info: GitInfo = { isRepo: true };
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 15_000 });
    // Windows trả "C:/..." còn dir là "C:\\..." ⇒ so sánh sau khi chuẩn hoá.
    info.toplevel = stdout.trim().replace(/\\/g, "/").replace(/\/$/, "");
  } catch {
    // repo chưa có commit hoặc lỗi quyền
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 15_000 });
    info.branch = stdout.trim();
  } catch {
    // detached HEAD hoặc repo chưa có commit
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain"], { timeout: 60_000 });
    info.dirty = stdout.trim() !== "";
  } catch {
    // bỏ qua — không phải lỗi chặn
  }
  return info;
}

/**
 * Kiểm project đích: repoRoot resolve được, là git repo, branch an toàn, cây làm việc sạch,
 * allowlist command/testSuites có dữ liệu. Đây là chỗ hay chết nhất khi chạy ticket thật.
 */
export async function checkProjects(only?: string): Promise<DoctorCheck[]> {
  const config = loadConfig();
  const names = only !== undefined ? [projectConfig(only).name] : Object.keys(config.projects.projects);
  const checks: DoctorCheck[] = [];
  for (const name of names) {
    const { config: project } = projectConfig(name);
    const required = only !== undefined;
    const repoRoot = resolveRepoRoot(name);
    if (repoRoot === null) {
      const env = project.repoRoot?.env ?? "(chưa khai báo)";
      checks.push({
        id: `project:${name}`,
        title: `Project ${name}: repoRoot`,
        level: required ? "fail" : "warn",
        detail: `chưa resolve được repoRoot (env ${env} chưa set, default ${project.repoRoot?.default ?? "null"})`,
        hint: `Set env ${env} trỏ tới repo đích trước khi chạy ticket thật (INV-06: runtime không đoán đường dẫn).`,
      });
      continue;
    }
    if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
      checks.push({
        id: `project:${name}`,
        title: `Project ${name}: repoRoot`,
        level: "fail",
        detail: `repoRoot resolve ra "${repoRoot}" nhưng không phải thư mục tồn tại`,
        hint: `Sửa env ${project.repoRoot?.env ?? ""} hoặc default trong config/projects.yaml.`,
      });
      continue;
    }

    const info = await gitInfo(repoRoot);
    const protectedBranches = config.projects.protectedBranches;
    const problems: string[] = [];   // chặn chạy — FAIL
    const warnings: string[] = [];   // chạy được nhưng dễ sinh lỗi/mất evidence — WARN
    const infos: string[] = [];      // thông tin, không phải vấn đề
    if (!info.isRepo) {
      problems.push("không phải git repo ⇒ validate_scope/git_diff/worktree không dùng được");
    } else {
      if (info.branch !== undefined && protectedBranches.includes(info.branch)) {
        warnings.push(`đang ở branch bảo vệ "${info.branch}" — thao tác ghi sẽ bị chặn (CLAUDE.md mục 2); tạo feature branch trước khi implement`);
      }
      if (info.dirty === true) warnings.push("working tree có thay đổi chưa commit — validate_scope sẽ tính cả diff này");
      if (info.branch === undefined) warnings.push("HEAD detached hoặc chưa có commit");
      if (info.toplevel !== undefined && !samePath(info.toplevel, repoRoot)) {
        infos.push(`repoRoot là thư mục CON của git repo tại ${info.toplevel} — diff/scope tính trên repo đó`);
      }
    }
    const allowedRoots = project.scope?.allowedRoots ?? [];
    if (allowedRoots.length === 0) problems.push("scope.allowedRoots rỗng ⇒ validate_scope không biết phạm vi cho phép");
    const commands = project.commands ?? {};
    if (Object.keys(commands).length === 0) problems.push("commands rỗng ⇒ run_build/run_test không có gì để chạy (ADR-08)");
    const suites = Object.keys(project.testSuites ?? {});
    if (suites.length === 0) warnings.push("testSuites rỗng ⇒ run_test/validate_scope không có suite nào để chạy");
    if (project.worktrees?.enabled === true) {
      const baseRef = project.worktrees.baseRef ?? "HEAD";
      try {
        const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", baseRef], { timeout: 15_000 });
        infos.push(`worktree BẬT, baseRef ${baseRef} → ${stdout.trim().slice(0, 8)}`);
      } catch {
        problems.push(`worktree BẬT nhưng baseRef "${baseRef}" không resolve được trong repo (repo chưa có commit?)`);
      }
    } else {
      infos.push("worktree TẮT (mặc định an toàn, INV-11) ⇒ `eng implement --parallel` sẽ từ chối");
    }

    checks.push({
      id: `project:${name}`,
      title: `Project ${name}: repo đích sẵn sàng`,
      level: problems.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok",
      detail: [
        `${repoRoot}${info.branch !== undefined ? ` @ ${info.branch}` : ""}${info.dirty === true ? " (dirty)" : ""}`,
        problems.join(" · "),
        warnings.join(" · "),
        infos.join(" · "),
      ]
        .filter((part) => part !== "")
        .join(" — "),
      ...(problems.length > 0
        ? { hint: "Sửa config/projects.yaml (scope/commands/testSuites) trước khi chạy phase thật." }
        : {}),
      details: { repoRoot, branch: info.branch ?? null, dirty: info.dirty ?? null, commands: Object.keys(commands), suites },
    });
  }
  return checks;
}
