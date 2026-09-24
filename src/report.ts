/** Renders BenchmarkReports (single run, or two runs side by side) as plain-text tables for the CLI. */

import type { BenchmarkReport } from "./harness.js";
import { formatPercent, formatTokensPerSecond, renderTable } from "./format.js";

export function formatSingleReport(report: BenchmarkReport): string {
  const rows = report.outcomes.map((o) => [
    o.taskId,
    o.category,
    o.passed ? "PASS" : "FAIL",
    o.generationTimeMs > 0 ? o.tokensPerSecond.toFixed(1) : "-",
  ]);
  const table = renderTable(["task", "category", "result", "tok/s"], rows);

  const s = report.summary;
  const summaryLines = [
    `${report.label} (runner: ${report.runnerName})`,
    `  ${s.passedTasks}/${s.totalTasks} passed (${formatPercent(s.passRate)})  |  avg ${formatTokensPerSecond(s.averageTokensPerSecond)}  |  ${s.totalTokensGenerated} tokens generated in ${(s.totalGenerationTimeMs / 1000).toFixed(2)}s`,
  ];

  return [...summaryLines, "", table].join("\n");
}

export function formatDetailedFailures(report: BenchmarkReport): string {
  const failures = report.outcomes.filter((o) => !o.passed);
  if (failures.length === 0) return "All tasks passed.";
  return failures.map((o) => `[FAIL] ${o.taskId}: ${o.detail}`).join("\n");
}

export interface ComparisonRow {
  taskId: string;
  category: string;
  aPassed: boolean;
  bPassed: boolean;
  aTokensPerSecond: number;
  bTokensPerSecond: number;
}

export interface ComparisonReport {
  a: BenchmarkReport;
  b: BenchmarkReport;
  rows: ComparisonRow[];
  /** Tasks present in one report but not the other (different task-suite versions), listed by id. */
  mismatchedTaskIds: string[];
}

export function compareReports(a: BenchmarkReport, b: BenchmarkReport): ComparisonReport {
  const bById = new Map(b.outcomes.map((o) => [o.taskId, o]));
  const rows: ComparisonRow[] = [];
  const mismatchedTaskIds: string[] = [];

  for (const outcomeA of a.outcomes) {
    const outcomeB = bById.get(outcomeA.taskId);
    if (!outcomeB) {
      mismatchedTaskIds.push(outcomeA.taskId);
      continue;
    }
    rows.push({
      taskId: outcomeA.taskId,
      category: outcomeA.category,
      aPassed: outcomeA.passed,
      bPassed: outcomeB.passed,
      aTokensPerSecond: outcomeA.tokensPerSecond,
      bTokensPerSecond: outcomeB.tokensPerSecond,
    });
  }

  for (const outcomeB of b.outcomes) {
    if (!a.outcomes.some((o) => o.taskId === outcomeB.taskId)) mismatchedTaskIds.push(outcomeB.taskId);
  }

  return { a, b, rows, mismatchedTaskIds };
}

export function formatComparisonReport(comparison: ComparisonReport): string {
  const { a, b, rows } = comparison;
  const rendered = rows.map((r) => [
    r.taskId,
    r.category,
    r.aPassed ? "PASS" : "FAIL",
    r.bPassed ? "PASS" : "FAIL",
    r.aTokensPerSecond > 0 ? r.aTokensPerSecond.toFixed(1) : "-",
    r.bTokensPerSecond > 0 ? r.bTokensPerSecond.toFixed(1) : "-",
  ]);
  const table = renderTable(["task", "category", `${a.label}`, `${b.label}`, `${a.label} tok/s`, `${b.label} tok/s`], rendered);

  const speedRatio =
    a.summary.averageTokensPerSecond > 0 ? b.summary.averageTokensPerSecond / a.summary.averageTokensPerSecond : 0;

  const summary = [
    `${a.label}: ${a.summary.passedTasks}/${a.summary.totalTasks} passed, avg ${formatTokensPerSecond(a.summary.averageTokensPerSecond)}`,
    `${b.label}: ${b.summary.passedTasks}/${b.summary.totalTasks} passed, avg ${formatTokensPerSecond(b.summary.averageTokensPerSecond)}`,
    speedRatio > 0
      ? `${b.label} runs ${speedRatio.toFixed(2)}x the tokens/sec of ${a.label}`
      : `Speed ratio unavailable (missing timing data).`,
  ];

  const mismatchNote =
    comparison.mismatchedTaskIds.length > 0
      ? `\n\nNote: task(s) present in only one run were excluded from the table: ${comparison.mismatchedTaskIds.join(", ")}`
      : "";

  return [...summary, "", table].join("\n") + mismatchNote;
}
