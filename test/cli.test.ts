import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildGgufFixture } from "./fixtures/buildGgufFixture.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(projectRoot, "src", "cli.ts");
const fakeModelScript = join(projectRoot, "test", "fixtures", "fakeModelScript.cjs");
// Invoke the locally installed tsx binary directly rather than through `npx`,
// which re-resolves/verifies the package on every call and roughly doubles
// wall time across this file's several real subprocess invocations.
const tsxBin = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

/** Runs the real CLI as a real subprocess (via tsx, no build step required) and returns its captured output. */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const quotedArgs = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const result = spawnSync(`"${tsxBin}" "${cliEntry}" ${quotedArgs}`, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: true,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("quantbench CLI (real subprocess integration test)", () => {
  let dir: string;
  let modelPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "quantbench-cli-test-"));
    modelPath = join(dir, "cli-test-model.gguf");
    writeFileSync(
      modelPath,
      buildGgufFixture(
        {
          "general.architecture": { kind: "string", value: "llama" },
          "general.name": { kind: "string", value: "cli-test-model" },
          "general.file_type": { kind: "u32", value: 7 }, // Q8_0
        },
        [],
      ),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("identify: parses the real GGUF fixture and prints its identity", () => {
    const { stdout, status } = runCli(["identify", modelPath]);
    expect(status).toBe(0);
    expect(stdout).toContain("name:            cli-test-model");
    expect(stdout).toContain("architecture:    llama");
    expect(stdout).toContain("quant:           Q8_0");
  });

  it("identify: exits non-zero with a clear error on a bad file", () => {
    const badPath = join(dir, "not-a-model.gguf");
    writeFileSync(badPath, "not a gguf file");
    const { status, stderr } = runCli(["identify", badPath]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/GGUF/);
  });

  it("run: executes the full task suite through the command runner (a real subprocess) end-to-end", () => {
    const outPath = join(dir, "report.json");
    const { stdout, status } = runCli([
      "run",
      "--model",
      modelPath,
      "--runner",
      "command",
      "--command",
      `node "${fakeModelScript}" {promptFile}`,
      "--out",
      outPath,
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain("cli-test-model Q8_0");
    expect(stdout).toContain("8/9 passed");
    expect(stdout).toContain("python-add-two");
    expect(stdout).toContain("PASS");
    // The fake model script deliberately answers the letter-count task wrong.
    expect(stdout).toContain("count-letter-occurrences");
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain('[FAIL] count-letter-occurrences');

    const report = JSON.parse(readFileSync(outPath, "utf8"));
    expect(report.label).toBe("cli-test-model Q8_0");
    expect(report.summary.totalTasks).toBe(9);
    expect(report.summary.passedTasks).toBe(8);
    expect(report.outcomes.find((o: { taskId: string }) => o.taskId === "count-letter-occurrences").passed).toBe(false);
  });

  it("run: supports --tasks to run a subset of the suite", () => {
    const { stdout, status } = runCli([
      "run",
      "--model",
      modelPath,
      "--runner",
      "command",
      "--command",
      `node "${fakeModelScript}" {promptFile}`,
      "--tasks",
      "python-add-two,syllogism-transitivity",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("2/2 passed");
  });

  it("run: fails fast with a clear error for an unknown --runner", () => {
    const { status, stderr } = runCli(["run", "--model", modelPath, "--runner", "nonsense"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Unknown --runner/);
  });

  it("run: fails fast when --runner ollama is used without --ollama-model", () => {
    const { status, stderr } = runCli(["run", "--model", modelPath, "--runner", "ollama"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--ollama-model/);
  });

  it("compare: renders two saved JSON reports side by side, including a real speed ratio", () => {
    const reportA = join(dir, "a.json");
    const reportB = join(dir, "b.json");
    runCli(["run", "--model", modelPath, "--runner", "command", "--command", `node "${fakeModelScript}" {promptFile}`, "--out", reportA, "--label", "modelA"]);
    runCli(["run", "--model", modelPath, "--runner", "command", "--command", `node "${fakeModelScript}" {promptFile}`, "--out", reportB, "--label", "modelB"]);

    const { stdout, status } = runCli(["compare", reportA, reportB]);
    expect(status).toBe(0);
    expect(stdout).toContain("modelA");
    expect(stdout).toContain("modelB");
    expect(stdout).toMatch(/\dx the tokens\/sec of/);
  });
});
