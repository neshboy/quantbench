import { describe, expect, it } from "vitest";
import { TASK_SUITE } from "../src/tasks/suite.js";
import { checkPythonFunction, extractCodeBlock, resolvePythonCommand } from "../src/tasks/pythonCheck.js";

function task(id: string) {
  const t = TASK_SUITE.find((t) => t.id === id);
  if (!t) throw new Error(`Missing task fixture setup: no task with id "${id}"`);
  return t;
}

describe("TASK_SUITE shape", () => {
  it("has between 5 and 10 tasks spanning all three categories", () => {
    expect(TASK_SUITE.length).toBeGreaterThanOrEqual(5);
    expect(TASK_SUITE.length).toBeLessThanOrEqual(10);
    const categories = new Set(TASK_SUITE.map((t) => t.category));
    expect(categories).toEqual(new Set(["coding", "instruction-following", "reasoning"]));
  });

  it("has unique task ids", () => {
    const ids = TASK_SUITE.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("pythonCheck helpers", () => {
  it("resolves a real working Python interpreter on this machine", () => {
    // This environment has `python` (3.12) but not `python3` on PATH; the
    // resolver must find *a* working interpreter either way.
    expect(resolvePythonCommand()).toBeDefined();
  });

  it("extractCodeBlock pulls fenced code, tolerating a python language tag", () => {
    expect(extractCodeBlock("```python\ndef f():\n    return 1\n```")).toBe("def f():\n    return 1");
    expect(extractCodeBlock("```\ndef f():\n    return 1\n```")).toBe("def f():\n    return 1");
    expect(extractCodeBlock("no fences here")).toBeUndefined();
  });

  it("checkPythonFunction fails cleanly with no code block", () => {
    const result = checkPythonFunction("sure, here's the answer: 42", {
      functionName: "f",
      cases: [{ args: [], expected: 1 }],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/No fenced/);
  });

  it("checkPythonFunction fails cleanly on a syntax error", () => {
    const result = checkPythonFunction("```python\ndef f(:\n  pass\n```", {
      functionName: "f",
      cases: [{ args: [], expected: 1 }],
    });
    expect(result.passed).toBe(false);
  });
});

describe("python-add-two checker", () => {
  const good = "Sure!\n```python\ndef add_two(a, b):\n    return a + b\n```";
  const wrong = "```python\ndef add_two(a, b):\n    return a - b\n```";
  const crashes = "```python\ndef add_two(a, b):\n    return a / 0\n```";

  it("passes a correct implementation", async () => {
    const result = await task("python-add-two").check(good);
    expect(result.passed).toBe(true);
  });

  it("fails a subtly wrong implementation", async () => {
    const result = await task("python-add-two").check(wrong);
    expect(result.passed).toBe(false);
  });

  it("fails an implementation that raises at runtime", async () => {
    const result = await task("python-add-two").check(crashes);
    expect(result.passed).toBe(false);
  });
});

describe("python-fizzbuzz checker", () => {
  const good =
    "```python\n" +
    "def fizzbuzz(n):\n" +
    "    if n % 15 == 0:\n" +
    "        return 'FizzBuzz'\n" +
    "    if n % 3 == 0:\n" +
    "        return 'Fizz'\n" +
    "    if n % 5 == 0:\n" +
    "        return 'Buzz'\n" +
    "    return str(n)\n" +
    "```";
  const missingFizzBuzzCase = "```python\ndef fizzbuzz(n):\n    if n % 3 == 0:\n        return 'Fizz'\n    if n % 5 == 0:\n        return 'Buzz'\n    return str(n)\n```";

  it("passes a fully correct implementation", async () => {
    const result = await task("python-fizzbuzz").check(good);
    expect(result.passed).toBe(true);
  });

  it("fails an implementation that misses the divisible-by-both case", async () => {
    const result = await task("python-fizzbuzz").check(missingFizzBuzzCase);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("15");
  });
});

describe("python-is-palindrome checker", () => {
  const good = "```python\ndef is_palindrome(s):\n    return s == s[::-1]\n```";
  const alwaysTrue = "```python\ndef is_palindrome(s):\n    return True\n```";

  it("passes a correct implementation", async () => {
    expect((await task("python-is-palindrome").check(good)).passed).toBe(true);
  });

  it("fails a stub that always returns True", async () => {
    expect((await task("python-is-palindrome").check(alwaysTrue)).passed).toBe(false);
  });
});

describe("json-fixed-schema checker", () => {
  it("passes an exact correct JSON object", () => {
    const result = task("json-fixed-schema").check('{"sum": 42, "is_even": true}') as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(true);
  });

  it("passes when the model wraps the JSON in prose (object is still extractable)", () => {
    const result = task("json-fixed-schema").check('Sure, here you go: {"sum": 42, "is_even": true} hope that helps!') as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(true);
  });

  it("fails on wrong arithmetic", () => {
    const result = task("json-fixed-schema").check('{"sum": 41, "is_even": true}') as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });

  it("fails on extra/missing keys", () => {
    const result = task("json-fixed-schema").check('{"sum": 42, "is_even": true, "extra": 1}') as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });

  it("fails on unparseable output", () => {
    const result = task("json-fixed-schema").check("I refuse to answer in JSON.") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });
});

describe("csv-two-rows checker", () => {
  it("passes an exact 3-line match", () => {
    const result = task("csv-two-rows").check("name,age\nBob,30\nCarol,25") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(true);
  });

  it("tolerates trailing blank lines", () => {
    const result = task("csv-two-rows").check("name,age\nBob,30\nCarol,25\n\n") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(true);
  });

  it("fails on swapped row order", () => {
    const result = task("csv-two-rows").check("name,age\nCarol,25\nBob,30") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });

  it("fails when markdown table formatting is used instead of CSV", () => {
    const result = task("csv-two-rows").check("| name | age |\n|---|---|\n| Bob | 30 |\n| Carol | 25 |") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });
});

describe("exact-word-count checker", () => {
  it("passes exactly 10 words", () => {
    const result = task("exact-word-count").check("A loop that repeats a block of code multiple times") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(true);
  });

  it("fails on 9 words", () => {
    const result = task("exact-word-count").check("A loop that repeats a block of code times") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });

  it("fails on 11 words", () => {
    const result = task("exact-word-count").check("A loop that repeats a block of code multiple times indeed") as import("../src/tasks/types.js").TaskCheckResult;
    expect(result.passed).toBe(false);
  });
});

describe("arithmetic-word-problem checker", () => {
  it("passes the exact correct integer", () => {
    expect((task("arithmetic-word-problem").check("19") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(true);
  });
  it("passes with surrounding whitespace", () => {
    expect((task("arithmetic-word-problem").check("  19\n") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(true);
  });
  it("fails a wrong number", () => {
    expect((task("arithmetic-word-problem").check("24") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(false);
  });
  it("fails a correct number buried in explanation text (output must be ONLY the integer)", () => {
    expect((task("arithmetic-word-problem").check("The answer is 19 apples.") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(false);
  });
});

describe("syllogism-transitivity checker", () => {
  it("passes 'Yes'", () => {
    expect((task("syllogism-transitivity").check("Yes") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(true);
  });
  it("passes case-insensitively with trailing punctuation", () => {
    expect((task("syllogism-transitivity").check("yes.") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(true);
  });
  it("fails 'No'", () => {
    expect((task("syllogism-transitivity").check("No") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(false);
  });
});

describe("count-letter-occurrences checker", () => {
  it("passes '3'", () => {
    expect((task("count-letter-occurrences").check("3") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(true);
  });
  it("fails a wrong digit", () => {
    expect((task("count-letter-occurrences").check("2") as import("../src/tasks/types.js").TaskCheckResult).passed).toBe(false);
  });
});
