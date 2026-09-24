/**
 * The task-suite contract: every benchmark task is a fixed prompt plus a
 * mechanical, programmatic pass/fail check on the model's raw output text.
 * No task is graded by "looks about right" or by another LLM's judgment --
 * every checker below is a deterministic function (string parsing, JSON
 * schema validation, or a real subprocess running literal input/output
 * test cases), so the same model output always produces the same verdict.
 */

export type TaskCategory = "coding" | "instruction-following" | "reasoning";

export interface TaskCheckResult {
  passed: boolean;
  /** Human-readable explanation of why it passed/failed, shown in reports. */
  detail: string;
}

export interface Task {
  id: string;
  category: TaskCategory;
  title: string;
  prompt: string;
  maxTokens: number;
  check(output: string): TaskCheckResult | Promise<TaskCheckResult>;
}
