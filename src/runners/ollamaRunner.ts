/**
 * Real inference runner backed by a locally running Ollama server.
 *
 * Ollama is a real, locally-runnable inference engine built on llama.cpp; it
 * exposes an HTTP API on localhost (default port 11434) and reports genuine
 * per-request generation timing (`eval_count` tokens generated over
 * `eval_duration` nanoseconds of actual generation time, excluding prompt
 * processing and model load) in every /api/generate response. That is real,
 * runner-measured tokens/sec, not a wall-clock guess.
 *
 * API reference: https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-completion
 */

import type { InferenceRequest, InferenceRunner } from "../runner.js";
import { makeInferenceResult } from "../runner.js";

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  eval_count?: number;
  eval_duration?: number; // nanoseconds
  error?: string;
}

export interface OllamaRunnerOptions {
  /** The model tag as `ollama list` shows it, e.g. "llama3.2:3b". */
  model: string;
  /** Base URL of the Ollama server. Defaults to the standard local address. */
  baseUrl?: string;
}

export class OllamaRunner implements InferenceRunner {
  readonly name: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OllamaRunnerOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.name = `ollama:${this.model}`;
  }

  async run(request: InferenceRequest): Promise<import("../runner.js").InferenceResult> {
    let httpResponse: Response;
    try {
      httpResponse = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: request.prompt,
          stream: false,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
          },
        }),
      });
    } catch (err) {
      throw new Error(
        `Could not reach Ollama at ${this.baseUrl}. Is "ollama serve" running? (${(err as Error).message})`,
      );
    }

    const body = (await httpResponse.json()) as OllamaGenerateResponse;

    if (!httpResponse.ok || body.error) {
      throw new Error(
        `Ollama returned an error for model "${this.model}": ${body.error ?? httpResponse.statusText}. ` +
          `Run "ollama pull ${this.model}" if the model isn't present locally.`,
      );
    }

    const tokensGenerated = body.eval_count ?? 0;
    const generationTimeMs = (body.eval_duration ?? 0) / 1_000_000;
    return makeInferenceResult(body.response, tokensGenerated, generationTimeMs);
  }
}
