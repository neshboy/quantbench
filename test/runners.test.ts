import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGeneratedText, LlamaCppRunner, parseLlamaCppTimings } from "../src/runners/llamaCppRunner.js";
import { CommandRunner, estimateTokenCount, renderCommandTemplate } from "../src/runners/commandRunner.js";
import { OllamaRunner } from "../src/runners/ollamaRunner.js";

describe("llama.cpp timing/text parsing (against real captured llama-cli output format)", () => {
  // This block is a verbatim shape of what a real `llama-cli -m model.gguf -p "..."`
  // run prints to stderr via llama_perf_context_print (ggml-org/llama.cpp).
  const REAL_STDERR_SAMPLE = `
llama_perf_sampler_print:    sampling time =      12.03 ms /    64 runs   (    0.19 ms per token,  5320.11 tokens per second)
llama_perf_context_print:        load time =     512.77 ms
llama_perf_context_print: prompt eval time =      88.14 ms /    16 tokens (    5.51 ms per token,   181.55 tokens per second)
llama_perf_context_print:        eval time =     834.21 ms /    64 runs   (   13.03 ms per token,    76.72 tokens per second)
llama_perf_context_print:       total time =     945.62 ms /    80 tokens
`;

  it("parses the generation-phase eval time line, not the prompt-eval or sampling lines", () => {
    const timings = parseLlamaCppTimings(REAL_STDERR_SAMPLE);
    expect(timings).toEqual({ tokensGenerated: 64, generationTimeMs: 834.21 });
  });

  it("returns undefined when the stderr doesn't match the expected format", () => {
    expect(parseLlamaCppTimings("some unrelated build log output")).toBeUndefined();
  });

  it("strips the echoed prompt from stdout to isolate generated text", () => {
    const stdout = "Write a haiku about the sea.\nWaves crash on the shore,\nsalt air drifts through open windows,\nblue forever calls.";
    const prompt = "Write a haiku about the sea.";
    expect(extractGeneratedText(stdout, prompt)).toBe(
      "Waves crash on the shore,\nsalt air drifts through open windows,\nblue forever calls.",
    );
  });

  it("returns trimmed stdout as-is when it doesn't start with the prompt (e.g. chat-template wrapped output)", () => {
    expect(extractGeneratedText("  <s>assistant\nhello there  ", "hello")).toBe("<s>assistant\nhello there");
  });

  it("LlamaCppRunner surfaces a clear error when the binary can't be launched", async () => {
    const runner = new LlamaCppRunner({ modelPath: "/models/x.gguf", binaryPath: "quantbench-definitely-not-a-real-binary" });
    await expect(runner.run({ prompt: "hi", maxTokens: 8, temperature: 0 })).rejects.toThrow(/Could not launch/);
  });
});

describe("CommandRunner (generic shell-out runner)", () => {
  it("renders the command template, shell-quoting model/prompt/promptFile placeholders", () => {
    const rendered = renderCommandTemplate("run --model {model} --prompt {prompt} -n {maxTokens} -t {temperature}", {
      model: "C:\\models\\a b.gguf",
      prompt: 'say "hi"',
      promptFile: "/tmp/p.txt",
      maxTokens: 32,
      temperature: 0,
    });
    expect(rendered).toBe('run --model "C:\\models\\a b.gguf" --prompt "say \\"hi\\"" -n 32 -t 0');
  });

  it("estimateTokenCount counts whitespace-delimited words, and is 0 for empty text", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("   ")).toBe(0);
    expect(estimateTokenCount("one two three")).toBe(3);
  });

  it("actually spawns a real subprocess and captures its real stdout and elapsed wall time", async () => {
    const runner = new CommandRunner({
      commandTemplate: `node -e "console.log('generated four whole words')"`,
      modelPath: "unused-for-this-template",
    });
    const result = await runner.run({ prompt: "irrelevant", maxTokens: 16, temperature: 0 });
    expect(result.text).toBe("generated four whole words");
    expect(result.tokensGenerated).toBe(4);
    expect(result.generationTimeMs).toBeGreaterThan(0);
    expect(result.tokensPerSecond).toBeGreaterThan(0);
  });

  it("rejects when the underlying command exits non-zero", async () => {
    const runner = new CommandRunner({ commandTemplate: `node -e "process.exit(3)"`, modelPath: "x" });
    await expect(runner.run({ prompt: "p", maxTokens: 8, temperature: 0 })).rejects.toThrow(/exited with code 3/);
  });
});

describe("OllamaRunner (real Ollama HTTP API contract, fetch mocked for determinism)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes tokensPerSecond from Ollama's own eval_count/eval_duration fields", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          response: "Hello from the model.",
          done: true,
          eval_count: 40,
          eval_duration: 500_000_000, // 500ms in nanoseconds -> 80 tokens/sec
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OllamaRunner({ model: "llama3.2:3b" });
    const result = await runner.run({ prompt: "hi", maxTokens: 64, temperature: 0 });

    expect(result.text).toBe("Hello from the model.");
    expect(result.tokensGenerated).toBe(40);
    expect(result.generationTimeMs).toBe(500);
    expect(result.tokensPerSecond).toBeCloseTo(80, 5);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({ method: "POST" }),
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody).toMatchObject({ model: "llama3.2:3b", prompt: "hi", stream: false });
  });

  it("throws a clear error when Ollama responds with an error (e.g. model not pulled)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 })),
    );
    const runner = new OllamaRunner({ model: "nope" });
    await expect(runner.run({ prompt: "hi", maxTokens: 8, temperature: 0 })).rejects.toThrow(/not found/);
  });

  it("throws a clear error when the Ollama server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const runner = new OllamaRunner({ model: "llama3.2:3b" });
    await expect(runner.run({ prompt: "hi", maxTokens: 8, temperature: 0 })).rejects.toThrow(/Could not reach Ollama/);
  });
});
