import { binary, checksum, FormatError, hex, unwrap, type PurHeader } from './binary.js';
import {
  TABLES,
  type DecodedRow,
  type SqliteDatabase,
  type SqliteEngine,
  type SqlValue,
  type TableName,
  type TableRow,
} from './tables.js';
import { tryDecodeVariant } from './variants.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function query(db: SqliteDatabase, sql: string): SqlValue[][] {
  const statement = db.prepare(sql);
  try {
    const rows: SqlValue[][] = [];
    while (statement.step()) rows.push(statement.get());
    return rows;
  } finally {
    statement.free();
  }
}

const quote = (identifier: string): string => '"' + identifier.replace(/"/g, '""') + '"';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function validateCell(value: SqlValue, kind: string, label: string): void {
  if (kind === 'raw') return; // Semantics of items.comment are not established.
  if (value === null && kind !== 'id') return;
  const valid =
    kind === 'id' || kind === 'integer'
      ? typeof value === 'number' && Number.isSafeInteger(value)
      : kind === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : kind === 'text'
          ? typeof value === 'string'
          : kind === 'blob'
            ? value instanceof Uint8Array
            : typeof value === 'string' || value instanceof Uint8Array;
  if (!valid) throw new FormatError(`Invalid ${label}: expected ${kind}`);
}

function inspectionVariant(value: ReturnType<typeof tryDecodeVariant>): JsonValue {
  if (value === null) return null;
  if (value.kind === 'undecoded') return { raw_hex: value.raw_hex };
  const { kind: _, ...fields } = value;
  // All decoded fields are JSON data; 'kind' is the TS API's extra discriminator.
  return fields as unknown as JsonValue;
}

/** In-memory, read-only reader. Call close() when finished to release SQLite. */
export class PurFile {
  readonly header: PurHeader;
  readonly database: Uint8Array;
  private db: SqliteDatabase | undefined;

  constructor(data: Uint8Array | ArrayBuffer, engine: SqliteEngine) {
    const unwrapped = unwrap(data);
    this.header = unwrapped.header;
    this.database = unwrapped.database;
    const db = new engine.Database(this.database);
    try {
      db.run('PRAGMA query_only=ON');
      const version = query(db, 'PRAGMA user_version')[0]?.[0];
      const application = query(db, 'PRAGMA application_id')[0]?.[0];
      if (version !== 200101 || application !== 940753918) {
        throw new FormatError(
          'Unsupported PureRef SQLite schema; expected application 940753918, schema 200101',
        );
      }
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Idempotent. Already returned rows and byte buffers remain usable. */
  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private getDatabase(): SqliteDatabase {
    if (!this.db) throw new Error('PurFile is closed');
    return this.db;
  }

  /** Raw cells, including extra columns, with embedded NULs preserved. */
  rows<T extends TableName>(table: T): (TableRow<T> & Record<string, SqlValue>)[] {
    if (!Object.prototype.hasOwnProperty.call(TABLES, table))
      throw new FormatError('Unknown table');
    const db = this.getDatabase();
    const columns = query(db, `PRAGMA table_info(${quote(table)})`).map((row) => String(row[1]));
    const expected = TABLES[table];
    if (Object.keys(expected).some((column) => !columns.includes(column))) {
      throw new FormatError(`Missing required columns in ${table}`);
    }
    // sql.js's string getter stops at NUL. Fetch TEXT as UTF-8 BLOB plus its
    // original storage class, then decode in JS to retain the entire value.
    const projection = columns
      .flatMap((column) => {
        const q = quote(column);
        return [
          `typeof(${q})`,
          `CASE WHEN typeof(${q})='text' THEN CAST(${q} AS BLOB) ELSE ${q} END`,
        ];
      })
      .join(',');
    return query(db, `SELECT ${projection} FROM ${quote(table)}`).map((values) => {
      const row: Record<string, SqlValue> = Object.create(null) as Record<string, SqlValue>;
      columns.forEach((column, i) => {
        const storage = values[i * 2];
        let value = values[i * 2 + 1] ?? null;
        if (storage === 'text') {
          if (!(value instanceof Uint8Array))
            throw new FormatError('SQLite TEXT conversion did not return bytes');
          try {
            value = utf8.decode(value);
          } catch {
            throw new FormatError(`Invalid UTF-8 in ${table}.${column}`);
          }
        }
        if (storage === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
          throw new FormatError(`Unsafe integer in ${table}.${column}`);
        }
        row[column] = value;
      });
      for (const [column, kind] of Object.entries(expected))
        validateCell(row[column] ?? null, kind, `${table}.${column}`);
      return row as TableRow<T> & Record<string, SqlValue>;
    });
  }

  /** Decode Qt cells; unknown variants and unsupported strokes retain raw data. */
  decodedRows<T extends TableName>(table: T): DecodedRow<T>[] {
    return this.rows(table).map((row) => {
      const result: Record<string, unknown> = { ...row };
      for (const [column, kind] of Object.entries(TABLES[table])) {
        if (kind === 'variant')
          result[column] = tryDecodeVariant(row[column] as string | Uint8Array | null);
      }
      return result as DecodedRow<T>;
    });
  }

  /** Diagnostic summary matching the Python reader's inspect() JSON shape. */
  inspect(): Record<string, JsonValue> {
    const { thumbnail, ...header } = this.header;
    const result: Record<string, JsonValue> = {
      header: { ...header, thumbnail_bytes: thumbnail?.length ?? 0 },
      integrity_check: query(this.getDatabase(), 'PRAGMA integrity_check').map((row) =>
        String(row[0]),
      ),
    };
    for (const table of Object.keys(TABLES) as TableName[]) {
      result[table] = this.rows(table).map((row) => {
        const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
        for (const [key, value] of Object.entries(row)) {
          const kind = (TABLES[table] as Record<string, string>)[key];
          if (kind === 'variant' && value !== null) {
            out[key] = inspectionVariant(tryDecodeVariant(value as string | Uint8Array));
          } else if (value instanceof Uint8Array) {
            out[key] = { bytes: value.length, md5: checksum(value) };
          } else if (typeof value === 'string' && value.includes('\0')) {
            out[key] = { raw_hex: hex(binary(value)) };
          } else {
            out[key] = value;
          }
        }
        return out;
      });
    }
    return result;
  }
}
