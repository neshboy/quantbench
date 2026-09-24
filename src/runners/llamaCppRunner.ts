/**
 * Real inference runner backed by llama.cpp's `llama-cli` binary, invoked as
 * a one-shot subprocess per prompt.
 *
 * llama.cpp prints a real performance report to stderr after generation,
 * e.g. (actual format from llama_perf_context_print, ggml-org/llama.cpp):
 *
 *   llama_perf_context_print:        eval time =     834.21 ms /    64 runs   (   13.03 ms per token,    76.72 tokens per second)
 *
 * We parse that line for genuine tool-reported tokens/sec rather than timing
 * the subprocess ourselves, so a slow process launch or model load doesn't
 * skew the measured generation speed.
 *
 * Not exercised against a live binary in every environment (llama-cli must
 * be built/installed separately) -- see README's Limitations section --
 * but the timing-line parser is unit-tested against real captured
 * llama.cpp output text.
 */

import { spawn } from "node:child_process";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "../runner.js";
import { makeInferenceResult } from "../runner.js";

export interface LlamaCppRunnerOptions {
  /** Path to the GGUF model file to load with `-m`. */
  modelPath: string;
  /** Path to the llama-cli (or compatible) binary. Defaults to "llama-cli" on PATH. */
  binaryPath?: string;
  /** Extra raw CLI args appended to every invocation (e.g. ["-t", "8"] for thread count). */
  extraArgs?: string[];
}

/** Matches llama.cpp's own generation-phase timing line, distinct from its "prompt eval time" line. */
const EVAL_TIME_LINE = /(?:^|\n)llama_perf_context_print:\s+eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*runs?\s*\([^)]*?([\d.]+)\s*tokens per second\)/;

export function parseLlamaCppTimings(stderr: string): { tokensGenerated: number; generationTimeMs: number } | undefined {
  const match = EVAL_TIME_LINE.exec(stderr);
  if (!match) return undefined;
  return { generationTimeMs: Number(match[1]), tokensGenerated: Number(match[2]) };
}

/**
 * llama-cli's plain (non-chat) stdout is the prompt followed immediately by
 * the continuation. When the process echoes the prompt verbatim at the
 * start of stdout, the generated text is everything after it.
 */
export function extractGeneratedText(stdout: string, prompt: string): string {
  const trimmedStdout = stdout.replace(/^\s+/, "");
  if (trimmedStdout.startsWith(prompt)) {
    return trimmedStdout.slice(prompt.length).trim();
  }
  return trimmedStdout.trim();
}

export class LlamaCppRunner implements InferenceRunner {
  readonly name = "llama.cpp";
  constructor(private readonly options: LlamaCppRunnerOptions) {}

  async run(request: InferenceRequest): Promise<InferenceResult> {
    const binary = this.options.binaryPath ?? "llama-cli";
    const args = [
      "-m",
      this.options.modelPath,
      "-p",
      request.prompt,
      "-n",
      String(request.maxTokens),
      "--temp",
      String(request.temperature),
      "--no-display-prompt",
      "-no-cnv",
      ...(this.options.extraArgs ?? []),
    ];

    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (err) => {
        reject(
          new Error(
            `Could not launch llama.cpp binary "${binary}" (${err.message}). ` +
              `Install/build llama.cpp and ensure llama-cli is on PATH, or pass --llama-cpp-binary <path>.`,
          ),
        );
      });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`llama-cli exited with code ${code}. stderr:\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    const text = extractGeneratedText(stdout, request.prompt);
    const timings = parseLlamaCppTimings(stderr);
    if (!timings) {
      // Binary ran but its stderr didn't match the expected performance-report
      // format (e.g. a different llama.cpp build/flags). Report the text with
      // zeroed timing rather than guessing at a wall-clock number that would
      // misleadingly look like a real per-token measurement.
      return makeInferenceResult(text, 0, 0);
    }
    return makeInferenceResult(text, timings.tokensGenerated, timings.generationTimeMs);
  }
}
