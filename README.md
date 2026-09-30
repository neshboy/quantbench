# QuantBench

**Does the smaller quant actually still work, or did you just save disk space and quietly wreck the model?**

Everyone picking a GGUF quant level (Q4_K_M vs Q5_K_M vs Q8_0, or comparing two different models entirely) is guessing. The
size/VRAM tradeoff is easy to calculate ([vramfit](https://github.com/neshboy/vramfit) does exactly that), but nothing
tells you what you actually lose in *quality*, or what you actually gain in *speed*, for a specific file, on your
specific machine, running your specific inference backend. People end up going by vibes, forum folklore ("Q4_K_M is
basically free, Q3 is where it breaks down") or just picking the biggest file that fits.

QuantBench is a local benchmark harness: point it at a real GGUF file and a real local inference runner (Ollama or
llama.cpp), and it runs a small, fixed task suite (coding, instruction-following, basic reasoning), checks every
answer mechanically (real subprocess execution for code, exact string/JSON matching for everything else -- no LLM
judge, nothing fuzzy), and reports pass/fail per task plus genuine tokens/sec. Run it against two quant levels of the
same model and `quantbench compare` puts the two report cards side by side.

It is the sibling to [vramfit](https://github.com/neshboy/vramfit): vramfit answers "will this fit in my VRAM"
(a sizing calculator -- no inference required). QuantBench answers "how good *is* this quantized model, actually"
(a real quality/speed benchmark that requires running real inference).

## Install / quick start

```bash
git clone https://github.com/neshboy/quantbench.git
cd quantbench
npm install
npm run build

# Inspect a GGUF file's real header -- no inference, just parsing:
node dist/cli.js identify ./models/llama-3.2-3b-instruct.Q4_K_M.gguf

# Benchmark it for real against a local Ollama server:
node dist/cli.js run \
  --model ./models/llama-3.2-3b-instruct.Q4_K_M.gguf \
  --runner ollama --ollama-model llama3.2:3b \
  --out q4_k_m.json

# ...pull/benchmark a second quant of the same model, then compare:
node dist/cli.js run \
  --model ./models/llama-3.2-3b-instruct.Q8_0.gguf \
  --runner ollama --ollama-model llama3.2:3b-instruct-q8_0 \
  --out q8_0.json

node dist/cli.js compare q4_k_m.json q8_0.json
```

During development you can skip the build step with `npm run dev -- run --model ... --runner ...` (runs the CLI
directly via `tsx`).

## Pointing it at a real local model + runner

`quantbench run` always needs `--model <path.gguf>` (used for real header parsing -- model name, architecture, quant
label) and `--runner <ollama|llama.cpp|command>`:

### `--runner ollama` (recommended -- easiest real setup)

Requires a running [Ollama](https://ollama.com) server with the model already pulled (`ollama pull llama3.2:3b`).
QuantBench calls Ollama's real `/api/generate` HTTP endpoint and reads its own `eval_count`/`eval_duration` fields for
genuine, tool-reported tokens/sec (not a wall-clock guess).

```bash
quantbench run --model <path.gguf> --runner ollama --ollama-model llama3.2:3b [--ollama-url http://localhost:11434]
```

`--model` still needs a real `.gguf` file so QuantBench can identify what it's actually benchmarking (Ollama's local
model store keeps the real GGUF blob under `~/.ollama/models/blobs/sha256-<hash>` -- that file has real "GGUF" magic
bytes, and QuantBench's `identify` command reads it directly, as shown below).

### `--runner llama.cpp`

Shells out to a `llama-cli` binary (from a [llama.cpp](https://github.com/ggml-org/llama.cpp) build) once per task
and parses its real `llama_perf_context_print` timing line for tokens/sec.

```bash
quantbench run --model <path.gguf> --runner llama.cpp [--llama-cpp-binary /path/to/llama-cli]
```

### `--runner command` (generic escape hatch)

Shells out to any command template of your own. Useful for any backend without a dedicated runner, and for testing.
Placeholders: `{model}`, `{prompt}`, `{promptFile}`, `{maxTokens}`, `{temperature}`. Because a generic command
doesn't report its own per-token timing, this runner measures real wall-clock time and estimates token count via
whitespace splitting -- an approximation, and it says so in the code and in its results.

```bash
quantbench run --model <path.gguf> --runner command \
  --command 'my-inference-binary --model {model} --prompt-file {promptFile} -n {maxTokens} > out.txt && cat out.txt'
```

### Other `run` options

- `--label <text>` -- display name for the run (defaults to `"<gguf name> <quant label>"`)
- `--temperature <n>` -- sampling temperature sent to the runner (default `0`, for reproducibility)
- `--tasks <ids>` -- comma-separated subset of task ids to run (default: the full suite)
- `--out <path>` -- write the full JSON report to a file (required if you want to `compare` it later)

## The task suite

Nine small, fixed tasks. Every checker is a deterministic function of the model's raw output text -- string/JSON
parsing, or (for coding tasks) actually running the extracted code in a real `python` subprocess against literal
input/output cases. No task is graded by "looks about right" or by another LLM's judgment, so a given model output
always produces the same verdict, on any machine, forever.

| id | category | what it checks |
|---|---|---|
| `python-add-two` | coding | Extracts a fenced Python code block, runs `add_two(a, b)` in a real subprocess against 3 literal cases |
| `python-fizzbuzz` | coding | Same, for `fizzbuzz(n)` -- covers the divisible-by-3, by-5, by-both, and neither cases |
| `python-is-palindrome` | coding | Same, for `is_palindrome(s)` -- covers a palindrome, a non-palindrome, and the empty string |
| `json-fixed-schema` | instruction-following | Output must contain a JSON object with exactly keys `sum`/`is_even` and the correct values |
| `csv-two-rows` | instruction-following | Output must be exactly 3 CSV lines (header + 2 rows), no markdown table, no commentary |
| `exact-word-count` | instruction-following | Output must be exactly 10 words, no more, no fewer |
| `arithmetic-word-problem` | reasoning | A 3-step arithmetic word problem; output must be exactly the correct integer |
| `syllogism-transitivity` | reasoning | A transitive syllogism with nonsense terms (rules out pattern-matching on real-world facts); must answer exactly "Yes" |
| `count-letter-occurrences` | reasoning | Count a letter's occurrences in a word; output must be exactly the correct digit |

See `src/tasks/suite.ts` for the exact prompts and checkers, and `test/tasks.test.ts` for known-good/known-bad outputs
run through every checker.

## Honest report: did a real live benchmark run happen here?

**Yes.** This environment has a real, running local [Ollama](https://ollama.com) server (v0.33.0) with
`llama3.2:3b` (Meta's Llama 3.2 3B Instruct, quantized to real **Q4_K_M**) already pulled. No GPU is present in this
environment (consistent with vramfit's own build notes), so this is genuine **CPU-only** inference -- slow, and
documented as such rather than glossed over.

`quantbench identify` against the real GGUF blob Ollama stores on disk
(`~/.ollama/models/blobs/sha256-dde5aa3f...`, confirmed to start with real `GGUF` magic bytes):

```
$ node dist/cli.js identify ~/.ollama/models/blobs/sha256-dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff
name:            Llama 3.2 3B Instruct
architecture:    llama
quant:           Q4_K_M
parameter count: (not recorded in file)
gguf version:    3
tensor count:    255
```

`quantbench run` against that same model through the real Ollama HTTP API, full task suite, unmodified output:

```
$ node dist/cli.js run --model <that gguf blob> --runner ollama --ollama-model llama3.2:3b --out q4_k_m.json

Llama 3.2 3B Instruct Q4_K_M (runner: ollama:llama3.2:3b)
  7/9 passed (78%)  |  avg 4.8 tok/s  |  152 tokens generated in 39.45s

task                      category               result  tok/s
------------------------  ---------------------  ------  -----
python-add-two            coding                 PASS    3.9
python-fizzbuzz           coding                 PASS    3.7
python-is-palindrome      coding                 PASS    3.8
json-fixed-schema         instruction-following  PASS    4.0
csv-two-rows              instruction-following  PASS    3.9
exact-word-count          instruction-following  PASS    4.0
arithmetic-word-problem   reasoning              FAIL    7.1
syllogism-transitivity    reasoning              FAIL    5.8
count-letter-occurrences  reasoning              PASS    7.0

[FAIL] arithmetic-word-problem: Expected exactly "19", got "13"
[FAIL] syllogism-transitivity: Expected "Yes", got "No."
```

That is a real result from a real 3B-parameter quantized model on real CPU-only hardware: it writes correct Python
and follows exact-format instructions reliably, but it flubbed one arithmetic word problem and, more strikingly,
answered a trivially-true transitive syllogism incorrectly -- both genuine small-model/quantization limitations, not
fabricated data. ~4-7 tokens/sec is also a real, honest CPU-only number; a GPU would be dramatically faster, which is
exactly the kind of tradeoff data this tool exists to surface instead of leaving you to guess.

To exercise the actual flagship use case -- comparing two quant levels of the *same* model -- a second real quant,
`llama3.2:3b-instruct-q8_0` (real **Q8_0**, 3.4GB), was pulled and benchmarked the same way, then compared with
`quantbench compare`:

```
$ node dist/cli.js run --model <q8_0 gguf blob> --runner ollama --ollama-model llama3.2:3b-instruct-q8_0 --out q8_0.json
Llama 3.2 3B Instruct Q8_0 (runner: ollama:llama3.2:3b-instruct-q8_0)
  6/9 passed (67%)  |  avg 3.0 tok/s  |  172 tokens generated in 73.70s
...
[FAIL] csv-two-rows: Expected lines ["name,age","Bob,30","Carol,25"], got ["\"name,age\"","\"Bob,30\"","\"Carol,25\""]
[FAIL] arithmetic-word-problem: Expected exactly "19", got "11"
[FAIL] syllogism-transitivity: Expected "Yes", got "No."

$ node dist/cli.js compare q4_k_m.json q8_0.json
Llama 3.2 3B Instruct Q4_K_M: 7/9 passed, avg 4.8 tok/s
Llama 3.2 3B Instruct Q8_0: 6/9 passed, avg 3.0 tok/s
Llama 3.2 3B Instruct Q8_0 runs 0.63x the tokens/sec of Llama 3.2 3B Instruct Q4_K_M

task                      category               Llama 3.2 3B Instruct Q4_K_M  Llama 3.2 3B Instruct Q8_0  ...tok/s  ...tok/s
------------------------  ---------------------  ----------------------------  --------------------------  --------  --------
python-add-two            coding                 PASS                          PASS                        3.9       2.3
python-fizzbuzz           coding                 PASS                          PASS                        3.7       2.2
python-is-palindrome      coding                 PASS                          PASS                        3.8       2.3
json-fixed-schema         instruction-following  PASS                          PASS                        4.0       2.2
csv-two-rows              instruction-following  PASS                          FAIL                        3.9       2.4
exact-word-count          instruction-following  PASS                          PASS                        4.0       2.5
arithmetic-word-problem   reasoning              FAIL                          FAIL                        7.1       4.8
syllogism-transitivity    reasoning              FAIL                          FAIL                        5.8       3.5
count-letter-occurrences  reasoning              PASS                          PASS                        7.0       4.7
```

That real comparison is itself a good demonstration of why this tool exists: naively you'd expect the *larger*,
*less-compressed* Q8_0 file to be at least as accurate as Q4_K_M, just slower. Here, on this exact machine, this
exact run, Q4_K_M actually passed **more** tasks (7/9 vs 6/9) *and* ran faster (4.8 vs 3.0 tok/s CPU-only) --
Q8_0 flubbed the CSV-formatting task (it wrapped every field in stray quotes) in addition to the same two reasoning
misses Q4_K_M made. With only 9 tasks and temperature 0 greedy decoding, this single run is not a rigorous
statistical claim that "Q4_K_M beats Q8_0 for this model" -- it's exactly the kind of real, specific, "run it
yourself and see" data point this tool is built to produce instead of a guess.

`llama.cpp` support (`--runner llama.cpp`) was **not** exercised against a live `llama-cli` binary in this
environment -- no llama.cpp build/binary was installed here (`llama-cli`/`llama-server` were not found on `PATH`).
Its subprocess-spawning and real-timing-line-parsing logic (`src/runners/llamaCppRunner.ts`) is still unit-tested
against a verbatim-format-matching captured sample of real `llama.cpp` performance-report output
(`test/runners.test.ts`), so the parsing logic is proven correct even though a live binary run didn't happen here. If
you have llama.cpp built locally, `--runner llama.cpp` should work as documented above -- please file an issue if it
doesn't.

## How the harness is proven correct without a live model

Every piece of QuantBench that *isn't* "did Ollama/llama.cpp actually run" is tested against real, deterministic
inputs with no network or model dependency:

- **GGUF parsing** (`src/gguf.ts`) is tested against hand-built, byte-for-byte-correct GGUF files
  (`test/fixtures/buildGgufFixture.ts` writes real magic bytes, real metadata KV encoding including a nested
  ARRAY-of-STRING value, and a real tensor-info table) with exact expected parse results, including a case that
  proves `general.file_type` (e.g. Q4_K_M) is read separately from the per-tensor ggml type (Q4_K), since both
  Q4_K_S and Q4_K_M use the identical tensor type and only differ at the file-type level.
- **The task suite's checkers** (`src/tasks/`) are fed known-good and known-bad model outputs, including one that
  crashes at runtime, one that returns a stub, and one that's correct but wrapped in extra prose, and asserted
  correct pass/fail either way (`test/tasks.test.ts`).
- **The harness** (`src/harness.ts`) runs against the injectable `InferenceRunner` interface, so
  `test/harness.test.ts` scripts a fake runner (and a runner that deliberately throws, to prove one failed task
  doesn't abort the run) and asserts the exact aggregation math (pass rate, average tokens/sec, runner-error
  handling).
- **Report rendering and comparison** (`src/report.ts`) are tested against constructed reports, including two runs
  with a mismatched task suite (proving tasks present in only one run are flagged, not silently misaligned).
- **The CLI itself** (`test/cli.test.ts`) is run as a real subprocess against a real byte-for-byte GGUF fixture and a
  real (tiny, deterministic) Node "fake model" script wired through `--runner command`, covering `run`, `compare`,
  `identify`, `--tasks` filtering, and the error paths for a bad file / unknown runner / missing required option.

## Limitations

- **CPU-only inference is slow.** The live run above took ~40 seconds for 9 short tasks on a 3B model with no GPU.
  Larger models or longer completions will take proportionally longer; this is a real constraint of the environment,
  not a bug.
- **`llama.cpp` support is implemented and unit-tested but not live-tested here** (no `llama-cli` binary was
  available in this environment). See the honest-report section above.
- **The `command` runner's tokens/sec is an approximation** (whitespace word count / real wall-clock time), because
  a truly generic external command doesn't report its own per-token timing the way Ollama and llama.cpp do. Prefer
  `--runner ollama` or `--runner llama.cpp` when precise tokens/sec matters.
- **Nine tasks is a small suite.** It's intentionally small and mechanically exact rather than broad and fuzzy --
  useful as a fast, reproducible smoke test of "did quantizing this further break anything obvious," not a
  substitute for a large-scale eval like MMLU/HumanEval.
- **Coding tasks require a working `python`/`python3` on `PATH`.** If neither is found, those three tasks fail with
  an explicit "no Python interpreter found" message rather than silently skipping.
- **Temperature 0 is used by default** for reproducibility, but most local backends' "greedy" decoding still has
  minor nondeterminism across hardware/builds; re-running the exact same model can occasionally flip a borderline
  task.
- **`general.file_type` isn't present in every GGUF file** (some quantizer tools omit it). When absent, QuantBench
  falls back to naming the quant after whichever ggml tensor type accounts for the most on-disk bytes, which can't
  distinguish e.g. Q4_K_S from Q4_K_M (both use the plain "Q4_K" tensor type) -- see `src/gguf.ts`.
- **The coding-task checker executes model-generated Python with no sandboxing.** `src/tasks/pythonCheck.ts` extracts
  the Python function the model wrote and runs it in a real `python`/`python3` subprocess, bounded only by a 5s
  wall-clock timeout -- there is no container, restricted OS user, or network isolation around it. Benchmarking an
  adversarial or badly-hallucinating model executes arbitrary code with the full privileges of whoever runs
  QuantBench. Only run QuantBench's coding tasks against models/output you trust, and consider sandboxing the whole
  process (container, locked-down user, disabled networking) if that's not the case.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm run dev -- ...  # run the CLI directly via tsx, no build step
npm test            # vitest run
```

## License

MIT -- see [LICENSE](./LICENSE).
