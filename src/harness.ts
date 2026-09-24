/**
 * Orchestrates running the task suite against an injected InferenceRunner
 * and produces a BenchmarkReport. This module has no knowledge of Ollama,
 * llama.cpp, or any other real backend -- it only depends on the
 * InferenceRunner interface, which is exactly what lets it be tested
 * against a scripted fake runner and still prove the real scoring/
 * aggregation logic is correct.
 */

import type { InferenceRunner } from "./runner.js";
import type { Task, TaskCategory } from "./tasks/types.js";

export interface TaskOutcome {
  taskId: string;
  title: string;
  category: TaskCategory;
  passed: boolean;
  detail: string;
  output: string;
  tokensGenerated: number;
  generationTimeMs: number;
  tokensPerSecond: number;
  /** Set when the runner itself threw (e.g. connection refused, binary missing) rather than the task failing its check. */
  runnerError?: string;
}

export interface BenchmarkSummary {
  totalTasks: number;
  passedTasks: number;
  passRate: number;
  /** Mean tokens/sec across tasks that reported real generation timing (excludes runner-error outcomes). */
  averageTokensPerSecond: number;
  totalTokensGenerated: number;
  totalGenerationTimeMs: number;
}

export interface BenchmarkReport {
  /** Display label for this run, e.g. "llama-3.2-3b Q4_K_M" -- caller-supplied, usually derived from GGUF identity. */
  label: string;
  runnerName: string;
  generatedAt: string;
  outcomes: TaskOutcome[];
  summary: BenchmarkSummary;
}

export interface RunBenchmarkOptions {
  /** Sampling temperature sent to the runner for every task. Defaults to 0 for reproducibility. */
  temperature?: number;
}

function summarize(outcomes: TaskOutcome[]): BenchmarkSummary {
  const totalTasks = outcomes.length;
  const passedTasks = outcomes.filter((o) => o.passed).length;
  const timedOutcomes = outcomes.filter((o) => o.generationTimeMs > 0);
  const totalTokensGenerated = outcomes.reduce((sum, o) => sum + o.tokensGenerated, 0);
  const totalGenerationTimeMs = outcomes.reduce((sum, o) => sum + o.generationTimeMs, 0);
  const averageTokensPerSecond =
    timedOutcomes.length > 0
      ? timedOutcomes.reduce((sum, o) => sum + o.tokensPerSecond, 0) / timedOutcomes.length
      : 0;

  return {
    totalTasks,
    passedTasks,
    passRate: totalTasks > 0 ? passedTasks / totalTasks : 0,
    averageTokensPerSecond,
    totalTokensGenerated,
    totalGenerationTimeMs,
  };
}

export async function runBenchmark(
  runner: InferenceRunner,
  tasks: Task[],
  label: string,
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const temperature = options.temperature ?? 0;
  const outcomes: TaskOutcome[] = [];

  for (const task of tasks) {
    try {
      const inference = await runner.run({ prompt: task.prompt, maxTokens: task.maxTokens, temperature });
      const checkResult = await task.check(inference.text);
      outcomes.push({
        taskId: task.id,
        title: task.title,
        category: task.category,
        passed: checkResult.passed,
        detail: checkResult.detail,
        output: inference.text,
        tokensGenerated: inference.tokensGenerated,
        generationTimeMs: inference.generationTimeMs,
        tokensPerSecond: inference.tokensPerSecond,
      });
    } catch (err) {
      outcomes.push({
        taskId: task.id,
        title: task.title,
        category: task.category,
        passed: false,
        detail: `Runner error: ${(err as Error).message}`,
        output: "",
        tokensGenerated: 0,
        generationTimeMs: 0,
        tokensPerSecond: 0,
        runnerError: (err as Error).message,
      });
    }
  }

  return {
    label,
    runnerName: runner.name,
    generatedAt: new Date().toISOString(),
    outcomes,
    summary: summarize(outcomes),
  };
}
