import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyModel, readGgufFile, totalTensorBytes } from "../src/gguf.js";
import { buildGgufFixture } from "./fixtures/buildGgufFixture.js";

// ggml_type ids used below (see src/ggmlType.ts GGML_TENSOR_TYPES)
const GGML_F32 = 0;
const GGML_Q4_K = 12; // block_q4_K: 256 elements / 144 bytes per block
const GGML_Q8_0 = 8; // block_q8_0: 32 elements / 34 bytes per block

describe("GGUF header parser (hand-built byte-for-byte fixture)", () => {
  let q4kmPath: string;
  let q4ksPath: string;
  let noFileTypePath: string;
  let badMagicPath: string;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "quantbench-test-"));

    // Fixture A: a "Q4_K_M" file -- general.file_type = 15 (LLAMA_FTYPE_MOSTLY_Q4_K_M).
    // One big Q4_K weight tensor + one tiny F32 norm tensor, plus a string-array
    // metadata value (a stand-in for a real tokenizer vocab list) to exercise
    // the ARRAY value-type branch end-to-end.
    const qElements = 4096 * 4096; // 16,777,216
    const qBlocks = qElements / 256; // 65,536
    const qBytes = qBlocks * 144; // 9,437,184 real block_q4_K bytes
    const normElements = 32;
    const normBytes = normElements * 4;

    q4kmPath = join(dir, "q4_k_m.gguf");
    writeFileSync(
      q4kmPath,
      buildGgufFixture(
        {
          "general.architecture": { kind: "string", value: "llama" },
          "general.name": { kind: "string", value: "quantbench-fixture-model" },
          "general.file_type": { kind: "u32", value: 15 }, // LLAMA_FTYPE_MOSTLY_Q4_K_M
          "general.parameter_count": { kind: "u64", value: 1_100_048_384 },
          "tokenizer.ggml.tokens": { kind: "stringArray", value: ["<s>", "</s>", "hello", "world"] },
        },
        [
          { name: "blk.0.attn_q.weight", shape: [4096, 4096], ggmlType: GGML_Q4_K, data: Buffer.alloc(qBytes) },
          { name: "output_norm.weight", shape: [32], ggmlType: GGML_F32, data: Buffer.alloc(normBytes) },
        ],
      ),
    );

    // Fixture B: same dominant tensor type (Q4_K) but general.file_type = 14
    // (LLAMA_FTYPE_MOSTLY_Q4_K_S) -- proves the parser distinguishes the file-level
    // quant *label* (_S vs _M) from the per-tensor ggml_type, which is identical here.
    q4ksPath = join(dir, "q4_k_s.gguf");
    writeFileSync(
      q4ksPath,
      buildGgufFixture(
        {
          "general.architecture": { kind: "string", value: "llama" },
          "general.name": { kind: "string", value: "quantbench-fixture-model" },
          "general.file_type": { kind: "u32", value: 14 }, // LLAMA_FTYPE_MOSTLY_Q4_K_S
        },
        [{ name: "blk.0.attn_q.weight", shape: [4096, 4096], ggmlType: GGML_Q4_K, data: Buffer.alloc(qBytes) }],
      ),
    );

    // Fixture C: no general.file_type at all -- forces the dominant-tensor-type
    // fallback path. Dominant by bytes is Q8_0 (9.4MB) over F32 (128 bytes).
    const q8Elements = 1024 * 1024;
    const q8Blocks = q8Elements / 32;
    const q8Bytes = q8Blocks * 34;
    noFileTypePath = join(dir, "no_file_type.gguf");
    writeFileSync(
      noFileTypePath,
      buildGgufFixture(
        { "general.architecture": { kind: "string", value: "gemma" } },
        [
          { name: "blk.0.attn_v.weight", shape: [1024, 1024], ggmlType: GGML_Q8_0, data: Buffer.alloc(q8Bytes) },
          { name: "output_norm.weight", shape: [32], ggmlType: GGML_F32, data: Buffer.alloc(128) },
        ],
      ),
    );

    badMagicPath = join(dir, "bad.gguf");
    writeFileSync(badMagicPath, Buffer.from("NOTAGGUFFILE"));
  });

  afterAll(() => {
    for (const p of [q4kmPath, q4ksPath, noFileTypePath, badMagicPath]) unlinkSync(p);
  });

  it("parses magic, version, and scalar/string metadata exactly", () => {
    const file = readGgufFile(q4kmPath);
    expect(file.version).toBe(3);
    expect(file.tensorCount).toBe(2);
    expect(file.metadata.get("general.architecture")).toBe("llama");
    expect(file.metadata.get("general.name")).toBe("quantbench-fixture-model");
    expect(file.metadata.get("general.file_type")).toBe(15);
    expect(file.metadata.get("general.parameter_count")).toBe(1_100_048_384);
  });

  it("parses a nested ARRAY-of-STRING metadata value exactly", () => {
    const file = readGgufFile(q4kmPath);
    expect(file.metadata.get("tokenizer.ggml.tokens")).toEqual(["<s>", "</s>", "hello", "world"]);
  });

  it("parses the tensor-info table (names, shapes, element counts, types)", () => {
    const file = readGgufFile(q4kmPath);
    expect(file.tensors).toHaveLength(2);
    expect(file.tensors[0]).toMatchObject({
      name: "blk.0.attn_q.weight",
      shape: [4096, 4096],
      elementCount: 4096 * 4096,
      ggmlType: GGML_Q4_K,
    });
    expect(file.tensors[1].name).toBe("output_norm.weight");
  });

  it("computes the exact real total tensor byte size from per-tensor ggml block layouts", () => {
    const file = readGgufFile(q4kmPath);
    // 65,536 blocks * 144 bytes (Q4_K) + 32 elements * 4 bytes (F32) = 9,437,184 + 128
    expect(totalTensorBytes(file.tensors)).toBe(9_437_184 + 128);
  });

  it("rejects a file with a bad magic number", () => {
    expect(() => readGgufFile(badMagicPath)).toThrow(/GGUF/);
  });

  it("rejects a truncated file with a clear end-of-file error", () => {
    const truncatedPath = join(dir, "truncated.gguf");
    const full = buildGgufFixture({ "general.architecture": { kind: "string", value: "llama" } }, []);
    writeFileSync(truncatedPath, full.subarray(0, full.length - 4));
    expect(() => readGgufFile(truncatedPath)).toThrow(/Unexpected end of file/);
    unlinkSync(truncatedPath);
  });

  describe("identifyModel", () => {
    it("labels the quant using general.file_type (Q4_K_M), not the raw ggml tensor type name", () => {
      const identity = identifyModel(readGgufFile(q4kmPath), q4kmPath);
      expect(identity.name).toBe("quantbench-fixture-model");
      expect(identity.architecture).toBe("llama");
      expect(identity.quantLabel).toBe("Q4_K_M");
      expect(identity.parameterCount).toBe(1_100_048_384);
    });

    it("distinguishes Q4_K_S from Q4_K_M even though both use the identical Q4_K ggml tensor type", () => {
      const identity = identifyModel(readGgufFile(q4ksPath), q4ksPath);
      expect(identity.quantLabel).toBe("Q4_K_S");
    });

    it("falls back to the dominant per-tensor ggml type when general.file_type is absent", () => {
      const identity = identifyModel(readGgufFile(noFileTypePath), noFileTypePath);
      expect(identity.quantLabel).toBe("Q8_0");
      expect(identity.architecture).toBe("gemma");
    });

    it("falls back to the file's basename when general.name is absent", () => {
      const identity = identifyModel(readGgufFile(noFileTypePath), noFileTypePath);
      expect(identity.name).toBe("no_file_type.gguf");
    });
  });
});
