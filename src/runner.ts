/**
 * The injectable inference-runner interface every backend (real or fake)
 * implements. This is the seam that makes the harness testable without a
 * live model: tests inject a fake runner with scripted outputs, while `run`
 * on the command line wires up a real one (Ollama, llama.cpp, or an
 * arbitrary shell command).
 */

export interface InferenceRequest {
  /** The exact prompt text to send to the model. */
  prompt: string;
  /** Upper bound on tokens to generate. */
  maxTokens: number;
  /** Sampling temperature. QuantBench tasks use 0 for reproducibility. */
  temperature: number;
}

export interface InferenceResult {
  /** The model's raw generated text (no prompt echo, no chat-template scaffolding). */
  text: string;
  /** Number of tokens the runner reports it generated. */
  tokensGenerated: number;
  /** Wall-clock (or runner-reported) time spent generating, in milliseconds. */
  generationTimeMs: number;
  /** tokensGenerated / (generationTimeMs / 1000), computed once so every caller agrees on it. */
  tokensPerSecond: number;
}

export interface InferenceRunner {
  /** Short label used in reports, e.g. "ollama:llama3.2:3b" or "llama.cpp". */
  readonly name: string;
  run(request: InferenceRequest): Promise<InferenceResult>;
}

/** Builds an InferenceResult, computing tokensPerSecond consistently (0 tokens/0 time => 0, never NaN/Infinity). */
export function makeInferenceResult(
  text: string,
  tokensGenerated: number,
  generationTimeMs: number,
): InferenceResult {
  const tokensPerSecond = generationTimeMs > 0 ? tokensGenerated / (generationTimeMs / 1000) : 0;
  return { text, tokensGenerated, generationTimeMs, tokensPerSecond };
}
