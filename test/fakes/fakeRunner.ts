/**
 * Deterministic fake InferenceRunner for tests. Returns scripted outputs
 * keyed by task id (or a default) instead of calling any real backend --
 * this is what proves the harness/scoring code is correct independent of
 * whether a live model is available.
 */

import type { InferenceRequest, InferenceResult, InferenceRunner } from "../../src/runner.js";
import { makeInferenceResult } from "../../src/runner.js";

export interface FakeRunnerScript {
  /** Response text keyed by a substring found in the prompt; first match wins. */
  responsesByPromptSubstring: Array<{ promptIncludes: string; text: string; tokensGenerated?: number; generationTimeMs?: number }>;
  /** Used when no scripted substring matches. */
  defaultText?: string;
}

export class FakeRunner implements InferenceRunner {
  readonly name = "fake";
  readonly requests: InferenceRequest[] = [];

  constructor(private readonly script: FakeRunnerScript) {}

  async run(request: InferenceRequest): Promise<InferenceResult> {
    this.requests.push(request);
    const entry = this.script.responsesByPromptSubstring.find((e) => request.prompt.includes(e.promptIncludes));
    const text = entry?.text ?? this.script.defaultText ?? "";
    const tokensGenerated = entry?.tokensGenerated ?? Math.max(1, Math.round(text.length / 4));
    const generationTimeMs = entry?.generationTimeMs ?? 100;
    return makeInferenceResult(text, tokensGenerated, generationTimeMs);
  }
}
