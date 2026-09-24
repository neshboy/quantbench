/**
 * ggml tensor type enum and their on-disk block layouts, plus the
 * llama_ftype enum GGUF files use to record their overall quantization
 * "recipe" (e.g. "this whole file is mostly Q4_K_M").
 *
 * Both tables reproduce values from the public ggml / llama.cpp headers
 * (ggml.h's `enum ggml_type`, llama.h's `enum llama_ftype`). The numeric
 * IDs are part of the on-disk GGUF contract: every GGUF reader (llama.cpp,
 * Ollama, etc.) must agree on them or the file is unreadable.
 */

export interface GgmlTypeInfo {
  /** Human-readable quant/type name, e.g. "Q4_K_M", "F16". */
  name: string;
  /** Elements per block for this type's packed representation. */
  blockElements: number;
  /** Bytes per block for this type's packed representation. */
  blockBytes: number;
}

/** `enum ggml_type` (ggml.h) -- per-tensor storage type. Only IDs that show
 * up in real-world published GGUF models are listed; anything else is
 * reported as an explicit "unrecognized" type rather than guessed at. */
export const GGML_TENSOR_TYPES: Record<number, GgmlTypeInfo> = {
  0: { name: "F32", blockElements: 1, blockBytes: 4 },
  1: { name: "F16", blockElements: 1, blockBytes: 2 },
  2: { name: "Q4_0", blockElements: 32, blockBytes: 18 },
  3: { name: "Q4_1", blockElements: 32, blockBytes: 20 },
  6: { name: "Q5_0", blockElements: 32, blockBytes: 22 },
  7: { name: "Q5_1", blockElements: 32, blockBytes: 24 },
  8: { name: "Q8_0", blockElements: 32, blockBytes: 34 },
  9: { name: "Q8_1", blockElements: 32, blockBytes: 40 },
  10: { name: "Q2_K", blockElements: 256, blockBytes: 84 },
  11: { name: "Q3_K", blockElements: 256, blockBytes: 110 },
  12: { name: "Q4_K", blockElements: 256, blockBytes: 144 },
  13: { name: "Q5_K", blockElements: 256, blockBytes: 176 },
  14: { name: "Q6_K", blockElements: 256, blockBytes: 210 },
  15: { name: "Q8_K", blockElements: 256, blockBytes: 292 },
  24: { name: "I8", blockElements: 1, blockBytes: 1 },
  25: { name: "I16", blockElements: 1, blockBytes: 2 },
  26: { name: "I32", blockElements: 1, blockBytes: 4 },
  28: { name: "BF16", blockElements: 1, blockBytes: 2 },
};

/** Exact on-disk byte size of one tensor, given its element count and ggml type. */
export function tensorByteSize(elementCount: number, ggmlType: number): number {
  const info = GGML_TENSOR_TYPES[ggmlType];
  if (!info) {
    throw new Error(
      `Unrecognized ggml tensor type id ${ggmlType}. This parser only knows the common ` +
        `dense/K-quant/integer types; newer or exotic quantizations (e.g. IQ*) aren't in the lookup table yet.`,
    );
  }
  const blocks = Math.ceil(elementCount / info.blockElements);
  return blocks * info.blockBytes;
}

/**
 * `enum llama_ftype` (llama.h) -- the whole-file "recipe name" GGUF files
 * store under the `general.file_type` metadata key. This is the value that
 * actually distinguishes "Q4_K_M" from plain "Q4_K" (both use the same
 * per-tensor Q4_K ggml_type; the _S/_M/_L suffix is a *mix* of tensor types
 * chosen by the quantizer, only recorded at the file level).
 */
export const LLAMA_FILE_TYPES: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4_MOE",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
  1024: "GUESSED",
};
