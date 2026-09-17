import { binary, FormatError, hex, Reader } from './binary.js';

export type Transform = [number, number, number, number, number, number, number, number, number];
export interface PainterPath {
  elements: [number, number, number][];
  cstart?: number;
  fill_rule?: number;
}
export interface Stroke {
  tag: number;
  color_spec: number;
  rgba16: [number, number, number, number];
  color_pad: number;
  width: number;
  path: PainterPath;
  options_hex: string;
}
interface VariantBase {
  type_id: number;
  is_null: boolean;
  type_name?: string;
  tail_hex?: string;
}
export type Variant = VariantBase &
  (
    | { kind: 'transform'; value: Transform }
    | { kind: 'rect'; value: [number, number, number, number] }
    | { kind: 'size'; value: [number, number] }
    | ({ kind: 'path' } & PainterPath)
    | { kind: 'strokes'; strokes: Stroke[] }
    | { kind: 'rational'; words: number[]; numerator?: number; denominator?: number }
    | { kind: 'unknown'; payload_hex: string }
  );
export interface UndecodedVariant {
  kind: 'undecoded';
  raw_hex: string;
  error: string;
}

function readPath(r: Reader): PainterPath {
  const count = r.u32();
  if (count > Math.floor(Math.max(0, r.remaining - (count ? 8 : 0)) / 20)) {
    throw new FormatError('Invalid path element count');
  }
  const elements: PainterPath['elements'] = [];
  for (let i = 0; i < count; i++) elements.push([r.i32(), r.f64(), r.f64()]);
  return count ? { elements, cstart: r.i32(), fill_rule: r.i32() } : { elements };
}

/** Decode the documented subset, preserving unknown payloads and trailing bytes. */
export function decodeVariant(value: string | Uint8Array | null): Variant | null {
  if (value === null) return null;
  const r = new Reader(binary(value));
  const base: VariantBase = { type_id: r.u32(), is_null: Boolean(r.u8()) };
  if (base.type_id === 1024) {
    const name = r.byteArray() ?? new Uint8Array();
    base.type_name = Array.from(name, (b) => (b < 128 ? String.fromCharCode(b) : '\ufffd'))
      .join('')
      .replace(/\0+$/, '');
  }
  let result: Variant;
  if (base.type_id === 80) {
    result = {
      ...base,
      kind: 'transform',
      value: [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()],
    };
  } else if (base.type_id === 20) {
    result = { ...base, kind: 'rect', value: [r.f64(), r.f64(), r.f64(), r.f64()] };
  } else if (base.type_id === 22) {
    result = { ...base, kind: 'size', value: [r.f64(), r.f64()] };
  } else if (base.type_name === 'QPainterPath') {
    result = { ...base, kind: 'path', ...readPath(r) };
  } else if (base.type_name === 'QList<GraphicsDrawItem::Stroke>') {
    const count = r.u32();
    if (count > Math.floor(r.remaining / 44)) throw new FormatError('Invalid stroke count');
    const strokes: Stroke[] = [];
    for (let i = 0; i < count; i++) {
      const tag = r.u8(),
        color_spec = r.u8();
      if (tag !== 100 || color_spec !== 1)
        throw new FormatError('Unsupported stroke tag/color representation');
      const alpha = r.u16(),
        red = r.u16(),
        green = r.u16(),
        blue = r.u16();
      strokes.push({
        tag,
        color_spec,
        rgba16: [red, green, blue, alpha],
        color_pad: r.u16(),
        width: r.f64(),
        path: readPath(r),
        options_hex: hex(r.take(20)),
      });
    }
    result = { ...base, kind: 'strokes', strokes };
  } else if (base.type_name === 'BigRational' && r.remaining === 32) {
    const words = Array.from({ length: 8 }, () => r.u32());
    result = { ...base, kind: 'rational', words };
    if (
      words[0] === 1 &&
      words[1] === 0 &&
      words[2] === 1 &&
      words[4] === 1 &&
      words[5] === 0 &&
      words[6] === 1
    ) {
      result.numerator = words[3]!;
      result.denominator = words[7]!;
    }
  } else {
    result = { ...base, kind: 'unknown', payload_hex: hex(r.take(r.remaining)) };
  }
  if (r.remaining) result.tail_hex = hex(r.take(r.remaining));
  return result;
}

/** Leave unsupported/corrupt cells available to callers without losing the board. */
export function tryDecodeVariant(
  value: string | Uint8Array | null,
): Variant | UndecodedVariant | null {
  if (value === null) return null;
  const raw = binary(value);
  try {
    return decodeVariant(raw);
  } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    return { kind: 'undecoded', raw_hex: hex(raw), error: error.message };
  }
}
