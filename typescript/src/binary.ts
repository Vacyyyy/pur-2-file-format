import { md5 } from '@noble/hashes/legacy.js';

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function checksum(bytes: Uint8Array): string {
  return hex(md5(bytes));
}

/** Recover Qt's byte-for-code-point representation; never UTF-8 encode it. */
export function binary(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) throw new FormatError('Serialized text contains a non-Latin-1 code point');
    bytes[i] = code;
  }
  return bytes;
}

export class Reader {
  pos = 0;
  constructor(readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.pos;
  }

  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) {
      throw new FormatError('Truncated field');
    }
    const bytes = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return bytes;
  }

  private view(n: number): DataView {
    const bytes = this.take(n);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    return this.view(1).getUint8(0);
  }
  u16(): number {
    return this.view(2).getUint16(0);
  }
  u32(): number {
    return this.view(4).getUint32(0);
  }
  i32(): number {
    return this.view(4).getInt32(0);
  }
  f64(): number {
    return this.view(8).getFloat64(0);
  }

  u64(): number {
    const value = this.u32() * 0x100000000 + this.u32();
    if (!Number.isSafeInteger(value))
      throw new FormatError('Offset exceeds JavaScript safe integer range');
    return value;
  }

  byteArray(): Uint8Array | null {
    const n = this.u32();
    if (n === 0xfffffffe) throw new FormatError('Qt extended lengths are not supported');
    return n === 0xffffffff ? null : this.take(n);
  }

  string(): string | null {
    const bytes = this.byteArray();
    if (bytes === null) return null;
    if (bytes.length % 2) throw new FormatError('Odd UTF-16 length');
    try {
      return new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new FormatError('Invalid UTF-16 string');
    }
  }
}

export interface PurHeader {
  format_version: '2.1';
  reserved: number;
  database_size: number;
  application_version: string | null;
  save_token: string | null;
  checksum_valid: boolean;
  checksum_start: number;
  thumbnail: Uint8Array | null;
  header_size: number;
}

/** Reconstruct the displaced SQLite prefix. Returned buffers own their bytes. */
export function unwrap(input: Uint8Array | ArrayBuffer): {
  header: PurHeader;
  database: Uint8Array;
} {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(data);
  if (r.string() !== '2.1')
    throw new FormatError('Unsupported envelope version; only 2.1 is verified');
  const reserved = r.u32();
  const offset = r.u64();
  const application_version = r.string();
  const save_token = r.string();
  const checksum_start = r.pos;
  const thumbnail = r.byteArray();
  const size = r.pos;
  if (offset < size || offset !== data.length - size) {
    throw new FormatError('Invalid displacement offset/header length');
  }
  const database = new Uint8Array(offset);
  database.set(data.subarray(offset));
  database.set(data.subarray(size, offset), size);
  const magic = new TextEncoder().encode('SQLite format 3\0');
  if (database.length < 100 || !magic.every((byte, i) => database[i] === byte)) {
    throw new FormatError('Reconstructed data lacks SQLite header');
  }
  const encodedPageSize = new DataView(database.buffer).getUint16(16);
  const pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || database.length % pageSize) {
    throw new FormatError('Invalid SQLite page size or database length');
  }
  return {
    header: {
      format_version: '2.1',
      reserved,
      database_size: offset,
      application_version,
      save_token,
      checksum_valid: checksum(data.subarray(checksum_start)) === save_token,
      checksum_start,
      thumbnail: thumbnail?.slice() ?? null,
      header_size: size,
    },
    database,
  };
}
