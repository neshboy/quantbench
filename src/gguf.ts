/**
 * Real GGUF binary format parser.
 *
 * GGUF ("GGML Universal File") is the on-disk format llama.cpp, Ollama and
 * the rest of the local-LLM ecosystem use to ship model weights. It is a
 * public, documented binary layout:
 *   https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 *
 * Byte layout (version >= 2, the layout every model published since late
 * 2023 uses):
 *
 *   offset 0   magic              4 bytes, ASCII "GGUF"
 *   offset 4   version            uint32 (little-endian)
 *   offset 8   tensor_count       uint64
 *   offset 16  metadata_kv_count  uint64
 *   offset 24  metadata_kv[metadata_kv_count]:
 *                key    : gguf_string (uint64 byte-length, then that many UTF-8 bytes)
 *                type   : uint32 (GgufMetadataValueType)
 *                value  : layout depends on `type` (see readMetadataValue)
 *   ...        tensor_info[tensor_count]:
 *                name         : gguf_string
 *                n_dimensions : uint32
 *                dimensions   : n_dimensions x uint64
 *                ggml_type    : uint32 (see ggmlType.ts GGML_TENSOR_TYPES)
 *                offset       : uint64 (byte offset into the tensor-data section)
 *
 * QuantBench only ever needs this header -- never the multi-gigabyte tensor
 * data blob that follows it -- so the reader below pulls in the file from
 * disk in doubling chunks instead of loading the whole thing into memory.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { GGML_TENSOR_TYPES, LLAMA_FILE_TYPES, tensorByteSize } from "./ggmlType.js";

export enum GgufMetadataValueType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

export type GgufMetadataValue = number | bigint | string | boolean | GgufMetadataValue[];

export interface GgufTensorDescriptor {
  name: string;
  shape: number[];
  elementCount: number;
  ggmlType: number;
  dataOffset: bigint;
}

export interface GgufFile {
  version: number;
  tensorCount: number;
  metadata: Map<string, GgufMetadataValue>;
  tensors: GgufTensorDescriptor[];
}

/** A prefix of a file, read from disk in doubling chunks as the parser demands more bytes. */
class GgufByteWindow {
  private readonly fd: number;
  private readonly fileSize: number;
  private buf: Buffer;
  private cursor = 0;

  constructor(path: string) {
    this.fd = openSync(path, "r");
    this.fileSize = fstatSync(this.fd).size;
    const firstChunk = Math.min(this.fileSize, 4 * 1024 * 1024); // 4MB covers almost every real header
    this.buf = Buffer.alloc(firstChunk);
    readSync(this.fd, this.buf, 0, firstChunk, 0);
  }

  close(): void {
    closeSync(this.fd);
  }

  private require(nBytes: number): void {
    if (this.cursor + nBytes <= this.buf.length) return;
    const needed = this.cursor + nBytes;
    if (needed > this.fileSize) {
      throw new Error(
        `Unexpected end of file at byte ${needed} (file is only ${this.fileSize} bytes). ` +
          `This file is truncated or is not a valid GGUF file.`,
      );
    }
    const grown = Math.min(this.fileSize, Math.max(this.buf.length * 2, needed));
    const next = Buffer.alloc(grown);
    readSync(this.fd, next, 0, grown, 0);
    this.buf = next;
  }

  private take(n: number): Buffer {
    this.require(n);
    const slice = this.buf.subarray(this.cursor, this.cursor + n);
    this.cursor += n;
    return slice;
  }

  readU8(): number {
    return this.take(1).readUInt8(0);
  }
  readI8(): number {
    return this.take(1).readInt8(0);
  }
  readU16(): number {
    return this.take(2).readUInt16LE(0);
  }
  readI16(): number {
    return this.take(2).readInt16LE(0);
  }
  readU32(): number {
    return this.take(4).readUInt32LE(0);
  }
  readI32(): number {
    return this.take(4).readInt32LE(0);
  }
  readF32(): number {
    return this.take(4).readFloatLE(0);
  }
  readF64(): number {
    return this.take(8).readDoubleLE(0);
  }
  readU64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  readI64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }
  readBool(): boolean {
    return this.readU8() !== 0;
  }
  readString(): string {
    const length = Number(this.readU64());
    return this.take(length).toString("utf8");
  }
}

/** Collapses a uint64/int64 down to `number` when it safely fits, otherwise keeps the bigint. */
function shrinkToNumberIfSafe(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function readMetadataValue(w: GgufByteWindow, type: GgufMetadataValueType): GgufMetadataValue {
  switch (type) {
    case GgufMetadataValueType.UINT8:
      return w.readU8();
    case GgufMetadataValueType.INT8:
      return w.readI8();
    case GgufMetadataValueType.UINT16:
      return w.readU16();
    case GgufMetadataValueType.INT16:
      return w.readI16();
    case GgufMetadataValueType.UINT32:
      return w.readU32();
    case GgufMetadataValueType.INT32:
      return w.readI32();
    case GgufMetadataValueType.FLOAT32:
      return w.readF32();
    case GgufMetadataValueType.FLOAT64:
      return w.readF64();
    case GgufMetadataValueType.BOOL:
      return w.readBool();
    case GgufMetadataValueType.STRING:
      return w.readString();
    case GgufMetadataValueType.UINT64:
      return shrinkToNumberIfSafe(w.readU64());
    case GgufMetadataValueType.INT64:
      return shrinkToNumberIfSafe(w.readI64());
    case GgufMetadataValueType.ARRAY: {
      const elementType = w.readU32() as GgufMetadataValueType;
      const length = Number(w.readU64());
      const values: GgufMetadataValue[] = new Array(length);
      for (let i = 0; i < length; i++) values[i] = readMetadataValue(w, elementType);
      return values;
    }
    default:
      throw new Error(`Unknown GGUF metadata value type id ${type as number}.`);
  }
}

/** Parses the GGUF header (magic, version, metadata key/value table, tensor-info table) of a real file. */
export function readGgufFile(path: string): GgufFile {
  const w = new GgufByteWindow(path);
  try {
    const magic = w.take(4).toString("ascii");
    if (magic !== "GGUF") {
      throw new Error(`Not a GGUF file: expected magic bytes "GGUF", got "${magic}".`);
    }

    const version = w.readU32();
    if (version < 2) {
      throw new Error(
        `GGUF version ${version} uses the legacy 32-bit string/count layout, which this parser ` +
          `does not support. Re-export the model with a modern (post-2023) llama.cpp/gguf tool.`,
      );
    }

    const tensorCount = Number(w.readU64());
    const metadataCount = Number(w.readU64());

    const metadata = new Map<string, GgufMetadataValue>();
    for (let i = 0; i < metadataCount; i++) {
      const key = w.readString();
      const valueType = w.readU32() as GgufMetadataValueType;
      metadata.set(key, readMetadataValue(w, valueType));
    }

    const tensors: GgufTensorDescriptor[] = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = w.readString();
      const nDims = w.readU32();
      const shape: number[] = [];
      for (let d = 0; d < nDims; d++) shape.push(Number(w.readU64()));
      const ggmlType = w.readU32();
      const dataOffset = w.readU64();
      const elementCount = shape.length === 0 ? 0 : shape.reduce((a, b) => a * b, 1);
      tensors.push({ name, shape, elementCount, ggmlType, dataOffset });
    }

    return { version, tensorCount, metadata, tensors };
  } finally {
    w.close();
  }
}

/** Sum of the exact on-disk byte size of every tensor, per its own real ggml type. */
export function totalTensorBytes(tensors: GgufTensorDescriptor[]): number {
  return tensors.reduce((sum, t) => sum + tensorByteSize(t.elementCount, t.ggmlType), 0);
}

/** Human name for the ggml type that accounts for the most tensor bytes in the file. */
function dominantTensorTypeName(tensors: GgufTensorDescriptor[]): string {
  const bytesByType = new Map<number, number>();
  for (const t of tensors) {
    const bytes = tensorByteSize(t.elementCount, t.ggmlType);
    bytesByType.set(t.ggmlType, (bytesByType.get(t.ggmlType) ?? 0) + bytes);
  }
  let bestType = -1;
  let bestBytes = -1;
  for (const [type, bytes] of bytesByType) {
    if (bytes > bestBytes) {
      bestBytes = bytes;
      bestType = type;
    }
  }
  return GGML_TENSOR_TYPES[bestType]?.name ?? `unknown(${bestType})`;
}

export interface ModelIdentity {
  /** `general.name` if present, otherwise the GGUF file's own basename. */
  name: string;
  /** `general.architecture`, e.g. "llama", "qwen2", "phi3". */
  architecture: string;
  /**
   * The file's overall quantization label, e.g. "Q4_K_M" vs "Q4_K_S" vs "Q8_0".
   * Read from `general.file_type` (the llama_ftype enum) when present -- that
   * is the only place the _S/_M/_L quant *mix* is actually recorded, since
   * Q4_K_S and Q4_K_M both use the identical Q4_K ggml_type on their biggest
   * tensors. Falls back to the dominant per-tensor ggml type name when
   * `general.file_type` is absent or unrecognized.
   */
  quantLabel: string;
  /** `general.parameter_count`, if the file records it. */
  parameterCount?: number;
}

export function identifyModel(file: GgufFile, sourcePath: string): ModelIdentity {
  const name = String(file.metadata.get("general.name") ?? basename(sourcePath));
  const architecture = String(file.metadata.get("general.architecture") ?? "unknown");

  const fileType = file.metadata.get("general.file_type");
  const fileTypeId = typeof fileType === "bigint" ? Number(fileType) : (fileType as number | undefined);
  const quantLabel =
    fileTypeId !== undefined && LLAMA_FILE_TYPES[fileTypeId] !== undefined
      ? LLAMA_FILE_TYPES[fileTypeId]
      : dominantTensorTypeName(file.tensors);

  const rawParamCount = file.metadata.get("general.parameter_count");
  const parameterCount =
    typeof rawParamCount === "bigint"
      ? Number(rawParamCount)
      : typeof rawParamCount === "number"
        ? rawParamCount
        : undefined;

  return { name, architecture, quantLabel, parameterCount };
}
