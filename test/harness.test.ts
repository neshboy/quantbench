import { describe, expect, it } from "vitest";
import { runBenchmark } from "../src/harness.js";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "../src/runner.js";
import { makeInferenceResult } from "../src/runner.js";
import type { Task } from "../src/tasks/types.js";
import { FakeRunner } from "./fakes/fakeRunner.js";

function syntheticTask(id: string, passes: boolean, promptIncludes = id): Task {
  return {
    id,
    category: "reasoning",
    title: id,
    prompt: `prompt for ${promptIncludes}`,
    maxTokens: 16,
    check: (output) => ({ passed: passes, detail: passes ? "ok" : `bad output: ${output}` }),
  };
}

class ThrowingRunner implements InferenceRunner {
  readonly name = "throwing";
  async run(_request: InferenceRequest): Promise<InferenceResult> {
    throw new Error("connection refused");
  }
}

describe("runBenchmark", () => {
  it("runs every task, sending its prompt/maxTokens/temperature to the runner", async () => {
    const runner = new FakeRunner({ responsesByPromptSubstring: [], defaultText: "output" });
    const tasks = [syntheticTask("t1", true), syntheticTask("t2", true)];

    await runBenchmark(runner, tasks, "test-label");

    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[0]).toEqual({ prompt: "prompt for t1", maxTokens: 16, temperature: 0 });
    expect(runner.requests[1]).toEqual({ prompt: "prompt for t2", maxTokens: 16, temperature: 0 });
  });

  it("respects a non-default temperature option", async () => {
    const runner = new FakeRunner({ responsesByPromptSubstring: [], defaultText: "x" });
    await runBenchmark(runner, [syntheticTask("t1", true)], "label", { temperature: 0.7 });
    expect(runner.requests[0].temperature).toBe(0.7);
  });

  it("records pass/fail per task using the task's own checker on the runner's output", async () => {
    const runner = new FakeRunner({ responsesByPromptSubstring: [], defaultText: "irrelevant" });
    const report = await runBenchmark(runner, [syntheticTask("pass-task", true), syntheticTask("fail-task", false)], "label");

    expect(report.outcomes.map((o) => [o.taskId, o.passed])).toEqual([
      ["pass-task", true],
      ["fail-task", false],
    ]);
    expect(report.summary.totalTasks).toBe(2);
    expect(report.summary.passedTasks).toBe(1);
    expect(report.summary.passRate).toBe(0.5);
  });

  it("computes real per-outcome tokensPerSecond from the runner's reported tokens/time", async () => {
    const runner = new FakeRunner({
      responsesByPromptSubstring: [{ promptIncludes: "fast", text: "x", tokensGenerated: 100, generationTimeMs: 1000 }],
      defaultText: "x",
    });
    const report = await runBenchmark(runner, [syntheticTask("fast-task", true, "fast")], "label");
    expect(report.outcomes[0].tokensPerSecond).toBeCloseTo(100, 5);
    expect(report.summary.averageTokensPerSecond).toBeCloseTo(100, 5);
  });

  it("averageTokensPerSecond excludes tasks with zero generation time (e.g. runner errors)", async () => {
    const runner = new FakeRunner({
      responsesByPromptSubstring: [{ promptIncludes: "timed", text: "x", tokensGenerated: 50, generationTimeMs: 500 }],
      defaultText: "x",
    });
    const tasks = [syntheticTask("timed-task", true, "timed"), syntheticTask("zero-task", true, "zero")];
    // zero-task gets defaultText with the FakeRunner's own default (non-zero) timing unless overridden;
    // force a genuinely zero-time outcome via a dedicated runner for this one assertion.
    class MixedRunner implements InferenceRunner {
      readonly name = "mixed";
      async run(request: InferenceRequest): Promise<InferenceResult> {
        if (request.prompt.includes("timed")) return makeInferenceResult("x", 50, 500);
        return makeInferenceResult("x", 0, 0);
      }
    }
    const report = await runBenchmark(new MixedRunner(), tasks, "label");
    expect(report.summary.averageTokensPerSecond).toBeCloseTo(100, 5); // only the timed task counts
    expect(report.summary.totalTokensGenerated).toBe(50);
  });

  it("catches a runner error for one task, records it as a failure, and still runs the remaining tasks", async () => {
    const runner = new ThrowingRunner();
    const report = await runBenchmark(runner, [syntheticTask("t1", true), syntheticTask("t2", true)], "label");

    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes[0].passed).toBe(false);
    expect(report.outcomes[0].runnerError).toMatch(/connection refused/);
    expect(report.outcomes[0].tokensPerSecond).toBe(0);
    expect(report.summary.passedTasks).toBe(0);
  });

  it("stamps the report with the runner's name and the caller-supplied label", async () => {
    const runner = new FakeRunner({ responsesByPromptSubstring: [], defaultText: "x" });
    const report = await runBenchmark(runner, [syntheticTask("t1", true)], "my-model Q4_K_M");
    expect(report.label).toBe("my-model Q4_K_M");
    expect(report.runnerName).toBe("fake");
    expect(new Date(report.generatedAt).toString()).not.toBe("Invalid Date");
  });
});
