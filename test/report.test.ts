import { describe, expect, it } from "vitest";
import type { BenchmarkReport } from "../src/harness.js";
import { compareReports, formatComparisonReport, formatDetailedFailures, formatSingleReport } from "../src/report.js";

function report(label: string, runnerName: string, outcomes: BenchmarkReport["outcomes"]): BenchmarkReport {
  const passedTasks = outcomes.filter((o) => o.passed).length;
  const timed = outcomes.filter((o) => o.generationTimeMs > 0);
  return {
    label,
    runnerName,
    generatedAt: "2026-09-24T00:00:00.000Z",
    outcomes,
    summary: {
      totalTasks: outcomes.length,
      passedTasks,
      passRate: outcomes.length > 0 ? passedTasks / outcomes.length : 0,
      averageTokensPerSecond: timed.length > 0 ? timed.reduce((s, o) => s + o.tokensPerSecond, 0) / timed.length : 0,
      totalTokensGenerated: outcomes.reduce((s, o) => s + o.tokensGenerated, 0),
      totalGenerationTimeMs: outcomes.reduce((s, o) => s + o.generationTimeMs, 0),
    },
  };
}

function outcome(taskId: string, passed: boolean, tokensPerSecond: number, detail = "detail") {
  return {
    taskId,
    title: taskId,
    category: "reasoning" as const,
    passed,
    detail,
    output: "output",
    tokensGenerated: tokensPerSecond > 0 ? 10 : 0,
    generationTimeMs: tokensPerSecond > 0 ? (10 / tokensPerSecond) * 1000 : 0,
    tokensPerSecond,
  };
}

describe("formatSingleReport", () => {
  it("includes the label, runner name, pass rate, and per-task PASS/FAIL rows", () => {
    const r = report("modelA Q4_K_M", "ollama:modelA", [
      outcome("task-one", true, 42.5),
      outcome("task-two", false, 10),
    ]);
    const text = formatSingleReport(r);

    expect(text).toContain("modelA Q4_K_M");
    expect(text).toContain("ollama:modelA");
    expect(text).toContain("1/2 passed");
    expect(text).toContain("50%");
    expect(text).toContain("task-one");
    expect(text).toContain("PASS");
    expect(text).toContain("task-two");
    expect(text).toContain("FAIL");
    expect(text).toContain("42.5");
  });

  it("shows a dash for tok/s when a task has no timing data (e.g. runner error)", () => {
    const r = report("m", "r", [outcome("t1", false, 0)]);
    const text = formatSingleReport(r);
    expect(text).toMatch(/t1\s+reasoning\s+FAIL\s+-/);
  });
});

describe("formatDetailedFailures", () => {
  it("lists only the failing tasks with their detail message", () => {
    const r = report("m", "r", [
      outcome("t1", true, 10, "should not appear"),
      outcome("t2", false, 10, "expected 19, got 24"),
    ]);
    const text = formatDetailedFailures(r);
    expect(text).not.toContain("should not appear");
    expect(text).toContain("t2");
    expect(text).toContain("expected 19, got 24");
  });

  it("reports all-passed when there are no failures", () => {
    const r = report("m", "r", [outcome("t1", true, 10)]);
    expect(formatDetailedFailures(r)).toBe("All tasks passed.");
  });
});

describe("compareReports", () => {
  it("pairs outcomes by task id across two reports", () => {
    const a = report("Q4_K_M", "ollama:m", [outcome("t1", true, 20), outcome("t2", false, 20)]);
    const b = report("Q8_0", "ollama:m", [outcome("t1", true, 10), outcome("t2", true, 10)]);
    const cmp = compareReports(a, b);

    expect(cmp.rows).toHaveLength(2);
    expect(cmp.rows[0]).toMatchObject({ taskId: "t1", aPassed: true, bPassed: true, aTokensPerSecond: 20, bTokensPerSecond: 10 });
    expect(cmp.rows[1]).toMatchObject({ taskId: "t2", aPassed: false, bPassed: true });
    expect(cmp.mismatchedTaskIds).toEqual([]);
  });

  it("flags task ids present in only one report instead of silently dropping or misaligning them", () => {
    const a = report("A", "r", [outcome("shared", true, 10), outcome("only-in-a", true, 10)]);
    const b = report("B", "r", [outcome("shared", true, 10), outcome("only-in-b", true, 10)]);
    const cmp = compareReports(a, b);

    expect(cmp.rows.map((r) => r.taskId)).toEqual(["shared"]);
    expect(cmp.mismatchedTaskIds.sort()).toEqual(["only-in-a", "only-in-b"]);
  });
});

describe("formatComparisonReport", () => {
  it("renders both labels, a per-task table, and a correct speed ratio", () => {
    const a = report("Q4_K_M", "ollama:m", [outcome("t1", true, 20)]);
    const b = report("Q8_0", "ollama:m", [outcome("t1", true, 10)]); // b is half the speed of a
    const text = formatComparisonReport(compareReports(a, b));

    expect(text).toContain("Q4_K_M");
    expect(text).toContain("Q8_0");
    expect(text).toContain("0.50x"); // b's avg tok/s (10) / a's avg tok/s (20)
  });

  it("appends a note listing task ids excluded from the table due to a mismatched suite", () => {
    const a = report("A", "r", [outcome("shared", true, 10), outcome("only-a", true, 10)]);
    const b = report("B", "r", [outcome("shared", true, 10)]);
    const text = formatComparisonReport(compareReports(a, b));
    expect(text).toContain("only-a");
  });
});
