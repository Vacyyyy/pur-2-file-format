/** Expected columns for schema 200101. Unknown extra columns remain in rows(). */
export const TABLES = {
  images: {
    id: 'id',
    source_type: 'integer',
    origin: 'text',
    source: 'text',
    format: 'text',
    checksum: 'text',
    data: 'blob',
    width: 'integer',
    height: 'integer',
  },
  metadata: {
    id: 'id',
    scene_rect: 'variant',
    application_version: 'text',
    view_transform: 'variant',
    thumbnail: 'blob',
    horizontal_scroll: 'integer',
    vertical_scroll: 'integer',
    last_save_path: 'text',
    last_load_path: 'text',
    last_load_checksum: 'text',
    saved: 'integer',
  },
  items: {
    parent: 'integer',
    id: 'id',
    name: 'text',
    transform: 'variant',
    sort_order: 'variant',
    z: 'number',
    opacity: 'number',
    locked: 'integer',
    comment: 'raw',
  },
  items_images: {
    image: 'integer',
    playback_speed: 'number',
    id: 'id',
    playback_state: 'integer',
    image_transform: 'variant',
    image_bounds: 'variant',
    playback_frame: 'integer',
    flags: 'integer',
  },
  items_notes: {
    text_color: 'text',
    id: 'id',
    fixed_size: 'variant',
    background_color: 'text',
    text: 'text',
    style: 'integer',
  },
  items_groups: { id: 'id', background_color: 'text', lock_mode: 'integer' },
  items_drawings: { id: 'id', strokes: 'variant' },
} as const;

export type TableName = keyof typeof TABLES;
export type SqlValue = string | number | Uint8Array | null;
type Cell<T> = T extends 'id'
  ? number
  : T extends 'raw'
    ? SqlValue
    : T extends 'integer' | 'number'
      ? number | null
      : T extends 'text'
        ? string | null
        : T extends 'blob'
          ? Uint8Array | null
          : string | Uint8Array | null;
export type TableRow<T extends TableName> = {
  [K in keyof (typeof TABLES)[T]]: Cell<(typeof TABLES)[T][K]>;
};

export type DecodedRow<T extends TableName> = {
  [K in keyof (typeof TABLES)[T]]: (typeof TABLES)[T][K] extends 'variant'
    ? import('./variants.js').Variant | import('./variants.js').UndecodedVariant | null
    : Cell<(typeof TABLES)[T][K]>;
};

/** Structural subset implemented by sql.js; callers own WASM initialization. */
export interface SqliteStatement {
  step(): boolean;
  get(): SqlValue[];
  free(): boolean;
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  run(sql: string): unknown;
  close(): void;
}
export interface SqliteEngine {
  Database: new (data: Uint8Array) => SqliteDatabase;
}
