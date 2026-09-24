/**
 * Hand-builds byte-for-byte valid GGUF files in memory for tests, following
 * the public GGUF layout documented at the top of src/gguf.ts. Written
 * independently for QuantBench (not copied from any sibling project),
 * though it targets the same real, public binary format.
 *
 * Encodes exactly the handful of value types QuantBench's fixtures exercise:
 * strings, u32, u64, f32, bool, and one nested ARRAY-of-STRING (to mimic a
 * real tokenizer vocab list, which is the one metadata shape every real
 * production GGUF file has that a minimal fixture might otherwise skip).
 */

const GGUF_VALUE_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

export type FixtureMetaValue =
  | { kind: "u32"; value: number }
  | { kind: "u64"; value: number | bigint }
  | { kind: "f32"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "stringArray"; value: string[] };

export interface FixtureTensor {
  name: string;
  shape: number[];
  ggmlType: number;
  /** Raw on-disk bytes for the tensor's data section. Length should match its real packed size. */
  data: Buffer;
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function f32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n, 0);
  return b;
}
function boolByte(v: boolean): Buffer {
  return Buffer.from([v ? 1 : 0]);
}
function ggufString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u64le(bytes.length), bytes]);
}

function encodeTypedValue(v: FixtureMetaValue): Buffer {
  switch (v.kind) {
    case "u32":
      return Buffer.concat([u32le(GGUF_VALUE_TYPE.UINT32), u32le(v.value)]);
    case "u64":
      return Buffer.concat([u32le(GGUF_VALUE_TYPE.UINT64), u64le(v.value)]);
    case "f32":
      return Buffer.concat([u32le(GGUF_VALUE_TYPE.FLOAT32), f32le(v.value)]);
    case "string":
      return Buffer.concat([u32le(GGUF_VALUE_TYPE.STRING), ggufString(v.value)]);
    case "bool":
      return Buffer.concat([u32le(GGUF_VALUE_TYPE.BOOL), boolByte(v.value)]);
    case "stringArray": {
      const parts = [u32le(GGUF_VALUE_TYPE.ARRAY), u32le(GGUF_VALUE_TYPE.STRING), u64le(v.value.length)];
      for (const s of v.value) parts.push(ggufString(s));
      return Buffer.concat(parts);
    }
  }
}

export function buildGgufFixture(
  metadata: Record<string, FixtureMetaValue>,
  tensors: FixtureTensor[] = [],
  version = 3,
): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from("GGUF", "ascii"));
  parts.push(u32le(version));
  parts.push(u64le(tensors.length));
  parts.push(u64le(Object.keys(metadata).length));

  for (const [key, value] of Object.entries(metadata)) {
    parts.push(ggufString(key));
    parts.push(encodeTypedValue(value));
  }

  for (const t of tensors) {
    parts.push(ggufString(t.name));
    parts.push(u32le(t.shape.length));
    for (const dim of t.shape) parts.push(u64le(dim));
    parts.push(u32le(t.ggmlType));
    parts.push(u64le(0)); // data-section offset; unused by a header-only parser
  }

  for (const t of tensors) parts.push(t.data);

  return Buffer.concat(parts);
}
