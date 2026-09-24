/**
 * The QuantBench standard task suite: 9 small, fixed tasks spanning coding,
 * instruction-following, and basic reasoning. Every checker below is
 * mechanical -- string/JSON parsing or a real Python subprocess -- so a
 * given model output always produces the same pass/fail verdict, on any
 * machine, forever. That reproducibility is the entire point: quality
 * scores that would change if you re-ran them are not real quality scores.
 */

import { checkPythonFunction } from "./pythonCheck.js";
import type { Task, TaskCheckResult } from "./types.js";

function extractJsonObject(output: string): unknown | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function exactTrim(output: string): string {
  return output.trim();
}

export const TASK_SUITE: Task[] = [
  // ---- coding ----
  {
    id: "python-add-two",
    category: "coding",
    title: "Write add_two(a, b)",
    prompt:
      "Write a Python function named exactly `add_two` that takes two integers and returns their sum. " +
      "Respond with ONLY a single Python code block containing the function definition, and no other text.",
    maxTokens: 300,
    check: (output) =>
      checkPythonFunction(output, {
        functionName: "add_two",
        cases: [
          { args: [2, 3], expected: 5 },
          { args: [-1, 1], expected: 0 },
          { args: [100, 250], expected: 350 },
        ],
      }),
  },
  {
    id: "python-fizzbuzz",
    category: "coding",
    title: "Write fizzbuzz(n)",
    prompt:
      "Write a Python function named exactly `fizzbuzz` that takes one integer n and returns the string \"Fizz\" if n " +
      'is divisible by 3, "Buzz" if divisible by 5, "FizzBuzz" if divisible by both, or the decimal string form of n ' +
      "otherwise (e.g. fizzbuzz(7) returns \"7\"). Respond with ONLY a single Python code block containing the function " +
      "definition, and no other text.",
    maxTokens: 350,
    check: (output) =>
      checkPythonFunction(output, {
        functionName: "fizzbuzz",
        cases: [
          { args: [3], expected: "Fizz" },
          { args: [5], expected: "Buzz" },
          { args: [15], expected: "FizzBuzz" },
          { args: [7], expected: "7" },
        ],
      }),
  },
  {
    id: "python-is-palindrome",
    category: "coding",
    title: "Write is_palindrome(s)",
    prompt:
      "Write a Python function named exactly `is_palindrome` that takes a string and returns True if it reads the same " +
      "forwards and backwards, else False. Respond with ONLY a single Python code block containing the function " +
      "definition, and no other text.",
    maxTokens: 300,
    check: (output) =>
      checkPythonFunction(output, {
        functionName: "is_palindrome",
        cases: [
          { args: ["level"], expected: true },
          { args: ["hello"], expected: false },
          { args: [""], expected: true },
        ],
      }),
  },

  // ---- instruction-following ----
  {
    id: "json-fixed-schema",
    category: "instruction-following",
    title: "Emit a fixed-schema JSON object",
    prompt:
      'Respond with ONLY a single JSON object (no markdown code fences, no explanation) with exactly two keys: "sum" ' +
      '(the integer sum of 17 and 25) and "is_even" (a boolean, true if that sum is even, else false). Output nothing else.',
    maxTokens: 80,
    check: (output): TaskCheckResult => {
      const parsed = extractJsonObject(output);
      if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { passed: false, detail: `Could not find a valid JSON object in output: ${output.slice(0, 200)}` };
      }
      const obj = parsed as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      if (keys.join(",") !== "is_even,sum") {
        return { passed: false, detail: `Expected exactly keys {is_even, sum}, got {${keys.join(", ")}}` };
      }
      if (obj.sum !== 42 || obj.is_even !== true) {
        return { passed: false, detail: `Expected {"sum":42,"is_even":true}, got ${JSON.stringify(obj)}` };
      }
      return { passed: true, detail: "JSON object matched the required schema and values exactly." };
    },
  },
  {
    id: "csv-two-rows",
    category: "instruction-following",
    title: "Emit exact 3-line CSV",
    prompt:
      'Output exactly the following as plain text CSV with no markdown formatting and no extra commentary: a header ' +
      'line "name,age" followed by two data lines "Bob,30" and "Carol,25". Output nothing else.',
    maxTokens: 60,
    check: (output): TaskCheckResult => {
      const lines = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const expected = ["name,age", "Bob,30", "Carol,25"];
      if (lines.length !== expected.length || !expected.every((e, i) => lines[i] === e)) {
        return { passed: false, detail: `Expected lines ${JSON.stringify(expected)}, got ${JSON.stringify(lines)}` };
      }
      return { passed: true, detail: "CSV output matched exactly, line for line." };
    },
  },
  {
    id: "exact-word-count",
    category: "instruction-following",
    title: "Answer in exactly 10 words",
    prompt:
      "Describe what a for-loop is in programming in EXACTLY 10 words, no more, no fewer. Respond with only those " +
      "10 words as plain text, and nothing else.",
    maxTokens: 60,
    check: (output): TaskCheckResult => {
      const words = exactTrim(output)
        .split(/\s+/)
        .filter((w) => w.length > 0);
      if (words.length !== 10) {
        return { passed: false, detail: `Expected exactly 10 words, counted ${words.length}: "${output.trim()}"` };
      }
      return { passed: true, detail: "Output contained exactly 10 words." };
    },
  },

  // ---- reasoning ----
  {
    id: "arithmetic-word-problem",
    category: "reasoning",
    title: "Multi-step arithmetic word problem",
    prompt:
      "There are 3 boxes with 8 apples each. Alice eats 5 apples from the total. How many apples remain in total? " +
      "Respond with ONLY the final integer, and nothing else.",
    maxTokens: 32,
    check: (output): TaskCheckResult => {
      const trimmed = exactTrim(output);
      const passed = trimmed === "19";
      return {
        passed,
        detail: passed ? "Correct: 3*8 - 5 = 19." : `Expected exactly "19", got "${trimmed.slice(0, 100)}"`,
      };
    },
  },
  {
    id: "syllogism-transitivity",
    category: "reasoning",
    title: "Transitive syllogism (nonsense terms)",
    prompt:
      "All Zorbs are Fribbles. All Fribbles are Wobbles. Is every Zorb definitely a Wobble? Answer with exactly one " +
      "word: Yes or No.",
    maxTokens: 16,
    check: (output): TaskCheckResult => {
      const answer = exactTrim(output).toLowerCase().replace(/[.!]+$/, "");
      const passed = answer === "yes";
      return {
        passed,
        detail: passed ? "Correctly answered Yes (transitivity holds)." : `Expected "Yes", got "${output.trim().slice(0, 60)}"`,
      };
    },
  },
  {
    id: "count-letter-occurrences",
    category: "reasoning",
    title: "Count a letter's occurrences in a word",
    prompt:
      'Count how many times the letter "r" appears in the word "strawberry" (case-insensitive). Respond with ONLY ' +
      "the digit, and nothing else.",
    maxTokens: 16,
    check: (output): TaskCheckResult => {
      const trimmed = exactTrim(output);
      const passed = trimmed === "3";
      return {
        passed,
        detail: passed ? 'Correct: "strawberry" contains the letter r 3 times.' : `Expected "3", got "${trimmed.slice(0, 60)}"`,
      };
    },
  },
];
