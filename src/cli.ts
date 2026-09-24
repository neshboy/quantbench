#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { identifyModel, readGgufFile } from "./gguf.js";
import { runBenchmark, type BenchmarkReport } from "./harness.js";
import type { InferenceRunner } from "./runner.js";
import { CommandRunner } from "./runners/commandRunner.js";
import { LlamaCppRunner } from "./runners/llamaCppRunner.js";
import { OllamaRunner } from "./runners/ollamaRunner.js";
import { compareReports, formatComparisonReport, formatDetailedFailures, formatSingleReport } from "./report.js";
import { TASK_SUITE } from "./tasks/suite.js";

const RUNNER_TYPES = ["ollama", "llama.cpp", "command"] as const;
type RunnerType = (typeof RUNNER_TYPES)[number];

interface RunOptions {
  model: string;
  runner: string;
  ollamaModel?: string;
  ollamaUrl: string;
  llamaCppBinary: string;
  command?: string;
  label?: string;
  temperature: string;
  out?: string;
  tasks?: string;
}

function isRunnerType(value: string): value is RunnerType {
  return (RUNNER_TYPES as readonly string[]).includes(value);
}

function buildRunner(options: RunOptions): InferenceRunner {
  if (!isRunnerType(options.runner)) {
    throw new Error(`Unknown --runner "${options.runner}". Expected one of: ${RUNNER_TYPES.join(", ")}.`);
  }

  switch (options.runner) {
    case "ollama":
      if (!options.ollamaModel) {
        throw new Error('--runner ollama requires --ollama-model <tag>, e.g. --ollama-model "llama3.2:3b".');
      }
      return new OllamaRunner({ model: options.ollamaModel, baseUrl: options.ollamaUrl });
    case "llama.cpp":
      return new LlamaCppRunner({ modelPath: options.model, binaryPath: options.llamaCppBinary });
    case "command":
      if (!options.command) {
        throw new Error(
          "--runner command requires --command <template>, e.g. " +
            '--command "my-binary --model {model} --prompt-file {promptFile} -n {maxTokens}".',
        );
      }
      return new CommandRunner({ commandTemplate: options.command, modelPath: options.model });
  }
}

function selectTasks(taskFilter: string | undefined) {
  if (!taskFilter) return TASK_SUITE;
  const wanted = new Set(taskFilter.split(",").map((s) => s.trim()));
  const selected = TASK_SUITE.filter((t) => wanted.has(t.id));
  const missing = [...wanted].filter((id) => !TASK_SUITE.some((t) => t.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown task id(s) in --tasks: ${missing.join(", ")}. Known ids: ${TASK_SUITE.map((t) => t.id).join(", ")}`);
  }
  return selected;
}

async function runCommand(options: RunOptions): Promise<void> {
  console.log(`Reading GGUF header: ${options.model}`);
  const file = readGgufFile(options.model);
  const identity = identifyModel(file, options.model);
  console.log(`  name=${identity.name} architecture=${identity.architecture} quant=${identity.quantLabel}`);

  const label = options.label ?? `${identity.name} ${identity.quantLabel}`;
  const runner = buildRunner(options);
  const tasks = selectTasks(options.tasks);
  const temperature = Number(options.temperature);
  if (!Number.isFinite(temperature)) {
    throw new Error(`--temperature must be a number, got "${options.temperature}".`);
  }

  console.log(`Running ${tasks.length} task(s) against runner "${runner.name}"...\n`);
  const report = await runBenchmark(runner, tasks, label, { temperature });

  console.log(formatSingleReport(report));
  console.log("");
  console.log(formatDetailedFailures(report));

  if (options.out) {
    writeFileSync(options.out, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nFull JSON report written to ${options.out}`);
  }
}

function compareCommand(pathA: string, pathB: string): void {
  const a = JSON.parse(readFileSync(pathA, "utf8")) as BenchmarkReport;
  const b = JSON.parse(readFileSync(pathB, "utf8")) as BenchmarkReport;
  console.log(formatComparisonReport(compareReports(a, b)));
}

function identifyCommand(modelPath: string): void {
  const file = readGgufFile(modelPath);
  const identity = identifyModel(file, modelPath);
  console.log(`name:            ${identity.name}`);
  console.log(`architecture:    ${identity.architecture}`);
  console.log(`quant:           ${identity.quantLabel}`);
  console.log(`parameter count: ${identity.parameterCount?.toLocaleString("en-US") ?? "(not recorded in file)"}`);
  console.log(`gguf version:    ${file.version}`);
  console.log(`tensor count:    ${file.tensorCount}`);
}

const program = new Command();
program
  .name("quantbench")
  .description("Local benchmark harness for the real quality/speed tradeoff of a quantized GGUF model.")
  .version("0.1.0");

program
  .command("run")
  .description("Run the QuantBench task suite against a local model and report pass/fail + tokens/sec.")
  .requiredOption("--model <path>", "path to the GGUF model file to identify and benchmark")
  .requiredOption("--runner <type>", `inference backend: ${RUNNER_TYPES.join(", ")}`)
  .option("--ollama-model <tag>", 'Ollama model tag to run, e.g. "llama3.2:3b" (required for --runner ollama)')
  .option("--ollama-url <url>", "Ollama server base URL", "http://localhost:11434")
  .option("--llama-cpp-binary <path>", "path to the llama-cli binary", "llama-cli")
  .option(
    "--command <template>",
    "shell command template for --runner command (placeholders: {model} {prompt} {promptFile} {maxTokens} {temperature})",
  )
  .option("--label <text>", "display label for this run; defaults to \"<gguf name> <quant label>\"")
  .option("--temperature <n>", "sampling temperature sent to the runner", "0")
  .option("--out <path>", "write the full JSON report to this file (needed for `quantbench compare`)")
  .option("--tasks <ids>", "comma-separated subset of task ids to run (default: the full suite)")
  .action(async (options: RunOptions) => {
    try {
      await runCommand(options);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("compare")
  .description("Compare two saved JSON reports (e.g. two quant levels of the same model) side by side.")
  .argument("<reportA>", "path to a JSON report saved via `quantbench run --out`")
  .argument("<reportB>", "path to a second JSON report")
  .action((reportA: string, reportB: string) => {
    try {
      compareCommand(reportA, reportB);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("identify")
  .description("Parse a GGUF file's header and print its model name, architecture, and quant label -- no inference.")
  .argument("<model>", "path to a .gguf file")
  .action((modelPath: string) => {
    try {
      identifyCommand(modelPath);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program.parse();
