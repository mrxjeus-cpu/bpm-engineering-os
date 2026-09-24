import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Copy fixture repo ra thư mục tạm và biến nó thành git repo thật.
 * Cần git repo thật để test validate_change_scope / git_* (INV-04).
 */
export function makeFixtureRepo(sourceDir) {
  const dir = mkdtempSync(path.join(tmpdir(), "domain-fixture-"));
  cpSync(sourceDir, dir, { recursive: true });

  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke-test@example.invalid");
  git("config", "user.name", "Smoke Test");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture: initial commit");

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
