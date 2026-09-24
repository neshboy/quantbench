#!/usr/bin/env node
/**
 * Deterministic stand-in "model" for the CLI integration test. Reads the
 * real prompt file QuantBench's CommandRunner wrote to disk and prints a
 * canned response selected by which real task suite prompt it matches, so
 * the CLI test exercises the real task checkers (including a deliberate
 * FAIL case) end-to-end through a real subprocess -- not a mocked runner.
 */
const fs = require("node:fs");

const promptFile = process.argv[2];
const prompt = fs.readFileSync(promptFile, "utf8");

const RESPONSES = [
  { includes: "add_two", text: "```python\ndef add_two(a, b):\n    return a + b\n```" },
  {
    includes: "fizzbuzz",
    text:
      "```python\ndef fizzbuzz(n):\n    if n % 15 == 0:\n        return 'FizzBuzz'\n    " +
      "if n % 3 == 0:\n        return 'Fizz'\n    if n % 5 == 0:\n        return 'Buzz'\n    return str(n)\n```",
  },
  { includes: "is_palindrome", text: "```python\ndef is_palindrome(s):\n    return s == s[::-1]\n```" },
  { includes: '"sum"', text: '{"sum": 42, "is_even": true}' },
  { includes: "name,age", text: "name,age\nBob,30\nCarol,25" },
  { includes: "EXACTLY 10 words", text: "A loop that repeats a block of code multiple times" },
  { includes: "boxes with 8 apples", text: "19" },
  { includes: "Zorbs", text: "Yes" },
  // Deliberately wrong, to prove the CLI surfaces a real FAIL, not just PASSes.
  { includes: "strawberry", text: "42" },
];

const match = RESPONSES.find((r) => prompt.includes(r.includes));
process.stdout.write(match ? match.text : "unrecognized prompt");
