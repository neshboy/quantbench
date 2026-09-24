/**
 * Real-subprocess checker for coding tasks: extracts the Python function the
 * model wrote from its output, then actually executes it in a real `python`
 * process against literal input/output test cases -- no heuristic "does
 * this look like working code" guessing.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCheckResult } from "./types.js";

const CODE_FENCE = /```(?:python)?\r?\n?([\s\S]*?)```/i;

/** Pulls the first fenced code block out of model output; undefined if the model didn't use one. */
export function extractCodeBlock(output: string): string | undefined {
  const match = CODE_FENCE.exec(output);
  return match ? match[1].trim() : undefined;
}

let cachedPythonCommand: string | undefined;

/** Finds a working Python interpreter on this machine, preferring `python3`, falling back to `python`. Cached for the process lifetime. */
export function resolvePythonCommand(): string | undefined {
  if (cachedPythonCommand !== undefined) return cachedPythonCommand;
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      cachedPythonCommand = candidate;
      return candidate;
    }
  }
  return undefined;
}

export interface PythonFunctionCase {
  args: unknown[];
  expected: unknown;
}

export interface PythonFunctionCheckOptions {
  functionName: string;
  cases: PythonFunctionCase[];
  /** Wall-clock timeout for the whole subprocess, guards against generated infinite loops. */
  timeoutMs?: number;
}

const HARNESS_TEMPLATE = (functionName: string) => `
import json, sys

_cases = json.loads(sys.argv[1])
_results = []
for _args in _cases:
    try:
        _results.append(${functionName}(*_args))
    except Exception as e:
        _results.append({"__quantbench_error__": f"{type(e).__name__}: {e}"})
print(json.dumps(_results))
`;

export function checkPythonFunction(output: string, options: PythonFunctionCheckOptions): TaskCheckResult {
  const code = extractCodeBlock(output);
  if (code === undefined) {
    return { passed: false, detail: "No fenced ```code block``` found in the model's output." };
  }

  const pythonCommand = resolvePythonCommand();
  if (!pythonCommand) {
    return {
      passed: false,
      detail: "No working Python interpreter (`python3`/`python`) found on this machine; cannot run the coding checker.",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "quantbench-py-"));
  const scriptPath = join(dir, "check.py");
  try {
    writeFileSync(scriptPath, `${code}\n${HARNESS_TEMPLATE(options.functionName)}`, "utf8");
    const argsJson = JSON.stringify(options.cases.map((c) => c.args));
    const proc = spawnSync(pythonCommand, [scriptPath, argsJson], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5000,
    });

    if (proc.error) {
      return { passed: false, detail: `Failed to run extracted code: ${proc.error.message}` };
    }
    if (proc.status !== 0) {
      return {
        passed: false,
        detail: `Extracted code raised an error (exit ${proc.status}):\n${(proc.stderr ?? "").trim().slice(-500)}`,
      };
    }

    let results: unknown[];
    try {
      results = JSON.parse(proc.stdout.trim());
    } catch {
      return { passed: false, detail: `Harness produced non-JSON output: ${proc.stdout.slice(0, 200)}` };
    }

    if (!Array.isArray(results) || results.length !== options.cases.length) {
      return { passed: false, detail: `Expected ${options.cases.length} results, got: ${proc.stdout.slice(0, 200)}` };
    }

    for (let i = 0; i < options.cases.length; i++) {
      const actual = results[i];
      const expected = options.cases[i].expected;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        return {
          passed: false,
          detail: `${options.functionName}(${options.cases[i].args.map((a) => JSON.stringify(a)).join(", ")}) => ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        };
      }
    }

    return { passed: true, detail: `All ${options.cases.length} literal test case(s) passed.` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
