/**
 * Generic runner for any local inference backend not given a dedicated
 * runner: it shells out to a user-supplied command template and measures
 * wall-clock generation time itself.
 *
 * Placeholders substituted into the template before it is run through the
 * shell:
 *   {model}       -- the --model path passed to `quantbench run`
 *   {prompt}      -- the task prompt, shell-escaped
 *   {promptFile}  -- path to a temp file containing the raw prompt text
 *                    (use this instead of {prompt} for multi-line prompts
 *                    or backends that read a file argument)
 *   {maxTokens}   -- the task's max-tokens budget
 *   {temperature} -- sampling temperature
 *
 * Because a generic command doesn't report its own per-token timing, this
 * runner can only measure real wall-clock time and estimate token count via
 * whitespace tokenization -- an approximation, clearly labeled as such. Use
 * the dedicated OllamaRunner or LlamaCppRunner when precise, tool-reported
 * tokens/sec matters.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, InferenceResult, InferenceRunner } from "../runner.js";
import { makeInferenceResult } from "../runner.js";

export interface CommandRunnerOptions {
  /** Shell command template; see placeholders in the module doc comment. */
  commandTemplate: string;
  /** Path substituted for {model}. */
  modelPath: string;
}

function shellQuote(value: string): string {
  // Double-quote and escape embedded double quotes; adequate for both
  // cmd.exe (via Node's shell:true) and POSIX shells for prompt text that
  // doesn't contain exotic control characters.
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Rough token estimate for backends that don't report their own count: ~1 token per whitespace-delimited word. */
export function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function renderCommandTemplate(
  template: string,
  vars: { model: string; prompt: string; promptFile: string; maxTokens: number; temperature: number },
): string {
  return template
    .replaceAll("{model}", shellQuote(vars.model))
    .replaceAll("{promptFile}", shellQuote(vars.promptFile))
    .replaceAll("{prompt}", shellQuote(vars.prompt))
    .replaceAll("{maxTokens}", String(vars.maxTokens))
    .replaceAll("{temperature}", String(vars.temperature));
}

export class CommandRunner implements InferenceRunner {
  readonly name = "command";
  constructor(private readonly options: CommandRunnerOptions) {}

  async run(request: InferenceRequest): Promise<InferenceResult> {
    const dir = mkdtempSync(join(tmpdir(), "quantbench-prompt-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, request.prompt, "utf8");

    const command = renderCommandTemplate(this.options.commandTemplate, {
      model: this.options.modelPath,
      prompt: request.prompt,
      promptFile,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    });

    const start = performance.now();
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
        child.on("error", (e) => reject(new Error(`Failed to launch command: ${e.message}`)));
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Command exited with code ${code}. stderr:\n${err}`));
            return;
          }
          resolve(out);
        });
      });
      const generationTimeMs = performance.now() - start;
      const text = stdout.trim();
      return makeInferenceResult(text, estimateTokenCount(text), generationTimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
