import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import initSqlJs from 'sql.js';
import {
  binary,
  decodeVariant,
  FormatError,
  PurFile,
  tryDecodeVariant,
  unwrap,
} from '../../dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SQL = await initSqlJs();
const fixtures = readdirSync(new URL('../../investigation/', import.meta.url))
  .filter((name) => name.endsWith('.pur'))
  .map((name) => `investigation/${name}`);
fixtures.push('examples/standalone-demo.pur');
const read = (name) => new Uint8Array(readFileSync(new URL(`../../${name}`, import.meta.url)));
const reference = spawnSync(
  process.env.PYTHON ?? 'python',
  ['typescript/tests/python_reference.py', ...fixtures],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  },
);
assert.equal(reference.error, undefined, 'Python 3.11+ must be available (or set PYTHON)');
assert.equal(reference.status, 0, reference.stderr);
const expected = JSON.parse(reference.stdout);
const plain = (value) => JSON.parse(JSON.stringify(value)); // Normalize object prototypes and signed zero on both sides.
const raw = (value) =>
  value instanceof Uint8Array ? { hex: Buffer.from(value).toString('hex') } : value;

for (const filename of fixtures) {
  test(`Python parity: ${filename}`, () => {
    const board = new PurFile(read(filename), SQL);
    try {
      assert.deepEqual(plain(board.inspect()), plain(expected[filename].inspect));
      assert.equal(
        createHash('md5').update(board.database).digest('hex'),
        expected[filename].database_md5,
      );
      for (const [table, rows] of Object.entries(expected[filename].rows)) {
        assert.deepEqual(
          plain(
            board
              .rows(table)
              .map((row) =>
                Object.fromEntries(Object.entries(row).map(([key, value]) => [key, raw(value)])),
              ),
          ),
          plain(rows),
        );
      }
    } finally {
      board.close();
    }
  });
}

const image = read('investigation/01-image.pur');
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const f64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};
const variant = (id, payload, name) =>
  Buffer.concat([
    u32(id),
    Buffer.from([0]),
    ...(name === undefined ? [] : [u32(Buffer.byteLength(name) + 1), Buffer.from(`${name}\0`)]),
    payload,
  ]);

test('subarray and ArrayBuffer inputs; returned buffers do not alias input', () => {
  const padded = new Uint8Array(image.length + 20);
  padded.set(image, 10);
  const view = padded.subarray(10, -10);
  const a = unwrap(view),
    b = unwrap(image.slice().buffer);
  assert.deepEqual(a, b);
  view.fill(0);
  assert.deepEqual(a, b);
});

test('rejects truncation, unsupported versions, malformed QStrings and offsets', () => {
  for (const length of [0, 3, 4, 9, 21, 40, 104, image.length - 1]) {
    assert.throws(() => unwrap(image.subarray(0, length)), FormatError);
  }
  const edit = (fn) => {
    const bytes = image.slice();
    fn(bytes, new DataView(bytes.buffer));
    return bytes;
  };
  for (const bytes of [
    edit((b) => {
      b[9] = 48;
    }),
    edit((b, v) => v.setUint32(0, 5)),
    edit((b, v) => v.setUint16(4, 0xd800)),
    edit((b, v) => v.setUint32(0, 0xfffffffe)),
    edit((b, v) => v.setUint32(0, 0xffffffff)),
    edit((b, v) => {
      v.setUint32(14, 0x80000000);
    }),
    edit((b, v) => {
      v.setUint32(14, 0);
      v.setUint32(18, 1);
    }),
    edit((b, v) => v.setUint32(104, 0x7fffffff)),
  ])
    assert.throws(() => unwrap(bytes), FormatError);
});

test('corrupt SQLite magic/page size is rejected and checksum mismatch is reported', () => {
  const { header } = unwrap(image);
  const corrupt = image.slice();
  corrupt[5000] ^= 1;
  assert.equal(unwrap(corrupt).header.checksum_valid, false);
  const magic = image.slice();
  magic[header.database_size] = 0;
  assert.throws(() => unwrap(magic), /SQLite header/);
  const page = image.slice();
  page[header.database_size + 16] = 3;
  assert.throws(() => unwrap(page), /page size/);
});

test('variants preserve NUL and high Latin-1 bytes, Unicode notes remain ordinary text', () => {
  const board = new PurFile(image, SQL);
  try {
    const text = board.rows('items')[0].transform;
    assert.equal(typeof text, 'string');
    assert.ok(text.includes('\0'));
    const transform = board.decodedRows('items')[0].transform;
    assert.equal(transform.kind, 'transform');
    assert.deepEqual(transform.value, [1, 0, 0, 0, 1, 0, 100, 200, 1]);
    assert.deepEqual(binary('\0\xff\x80'), new Uint8Array([0, 255, 128]));
    assert.throws(() => binary('Ω'), FormatError);
  } finally {
    board.close();
  }
});

test('unknown variants, trailing data, null cells and malformed payloads', () => {
  assert.equal(decodeVariant(null), null);
  const unknown = decodeVariant(variant(12345, Buffer.from([0, 255])));
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.payload_hex, '00ff');
  const size = decodeVariant(variant(22, Buffer.concat([f64(3), f64(4), Buffer.from([123])])));
  assert.equal(size.kind, 'size');
  assert.deepEqual(size.value, [3, 4]);
  assert.equal(size.tail_hex, '7b');
  assert.throws(() => decodeVariant(variant(80, Buffer.alloc(3))), FormatError);
  const malformed = variant(80, Buffer.from([255]));
  assert.equal(tryDecodeVariant(malformed).raw_hex, malformed.toString('hex'));
  assert.equal(tryDecodeVariant(malformed.toString('latin1')).raw_hex, malformed.toString('hex'));
  const nullVariant = variant(0, Buffer.alloc(0));
  nullVariant[4] = 1;
  assert.equal(decodeVariant(nullVariant).is_null, true);
});

test('path and stroke counts are bounded; unsupported encodings retain raw data', () => {
  for (const name of ['QPainterPath', 'QList<GraphicsDrawItem::Stroke>']) {
    assert.throws(() => decodeVariant(variant(1024, u32(0xffffffff), name)), FormatError);
  }
  assert.deepEqual(decodeVariant(variant(1024, u32(0), 'QPainterPath')).elements, []);
  const unsupported = variant(
    1024,
    Buffer.concat([u32(1), Buffer.alloc(44)]),
    'QList<GraphicsDrawItem::Stroke>',
  );
  assert.throws(() => decodeVariant(unsupported), /Unsupported stroke/);
  assert.equal(tryDecodeVariant(unsupported).kind, 'undecoded');
});

test('rational words are preserved without guessing unverified encodings', () => {
  const words = [1, 0, 1, 3, 1, 0, 1, 2];
  const decode = (list) =>
    decodeVariant(variant(1024, Buffer.concat(list.map(u32)), 'BigRational'));
  assert.equal(decode(words).numerator, 3);
  assert.equal(decode(words).denominator, 2);
  words[0] = 2;
  assert.deepEqual(decode(words).words, words);
  assert.equal(decode(words).numerator, undefined);
});

// Rebuild envelopes after modifying an isolated in-memory database. The parser
// intentionally reports the stale checksum; no input fixture is overwritten.
function changedDatabase(sql) {
  const db = new SQL.Database(unwrap(image).database);
  try {
    db.run(sql);
    const bytes = db.export();
    const header = image.slice(0, unwrap(image).header.header_size);
    new DataView(header.buffer).setBigUint64(14, BigInt(bytes.length));
    return Buffer.concat([header, bytes.subarray(header.length), bytes.subarray(0, header.length)]);
  } finally {
    db.close();
  }
}

test('decodedRows retains unsupported cells and raw rows remain accessible', () => {
  const bytes = changedDatabase("UPDATE items SET transform=x'0000005000FF'");
  const board = new PurFile(bytes, SQL);
  try {
    assert.equal(board.decodedRows('items')[0].transform.kind, 'undecoded');
    assert.deepEqual(plain(board.inspect().items[0].transform), { raw_hex: '0000005000ff' });
    assert.deepEqual(board.rows('items')[0].transform, new Uint8Array([0, 0, 0, 80, 0, 255]));
  } finally {
    board.close();
  }
});

test('safe table names, missing columns, unsafe integers, and unknown schema', () => {
  const board = new PurFile(image, SQL);
  try {
    for (const name of ['items; DROP TABLE images', 'constructor', '__proto__']) {
      assert.throws(() => board.rows(name), /Unknown table/);
    }
  } finally {
    board.close();
  }
  for (const sql of ['PRAGMA user_version=200100', 'PRAGMA application_id=0']) {
    assert.throws(
      () => new PurFile(changedDatabase(sql), SQL),
      /Unsupported PureRef SQLite schema/,
    );
  }
  for (const [sql, message] of [
    ['ALTER TABLE images DROP COLUMN data', /Missing required columns/],
    ['UPDATE images SET width=9007199254740993', /Unsafe integer/],
  ]) {
    const broken = new PurFile(changedDatabase(sql), SQL);
    try {
      assert.throws(() => broken.rows('images'), message);
    } finally {
      broken.close();
    }
  }
});

test('close is idempotent and constructor failures release SQLite', () => {
  let closed = 0,
    prepared = 0,
    freed = 0;
  const engine = {
    Database: class {
      constructor(bytes) {
        this.db = new SQL.Database(bytes);
      }
      run(sql) {
        return this.db.run(sql);
      }
      prepare(sql) {
        const statement = this.db.prepare(sql);
        prepared++;
        return {
          step: () => statement.step(),
          get: () => statement.get(),
          free: () => {
            freed++;
            return statement.free();
          },
        };
      }
      close() {
        closed++;
        this.db.close();
      }
    },
  };
  const board = new PurFile(image, engine);
  board.inspect();
  board.close();
  board.close();
  assert.equal(closed, 1);
  assert.equal(prepared, freed);
  assert.throws(() => board.rows('images'), /closed/);
  assert.throws(() => board.inspect(), /closed/);
  assert.throws(() => new PurFile(changedDatabase('PRAGMA user_version=0'), engine), FormatError);
  assert.equal(closed, 2);
  assert.equal(prepared, freed);
});

test('query exceptions free prepared statements and SQLite is read-only', () => {
  let underlying,
    freed = 0;
  const engine = {
    Database: class {
      constructor(bytes) {
        underlying = new SQL.Database(bytes);
      }
      run(sql) {
        return underlying.run(sql);
      }
      prepare(sql) {
        const statement = underlying.prepare(sql);
        return {
          step: () => statement.step(),
          get: () => {
            if (sql.startsWith('SELECT typeof')) throw new Error('Simulated binding failure');
            return statement.get();
          },
          free: () => {
            freed++;
            return statement.free();
          },
        };
      }
      close() {
        underlying.close();
      }
    },
  };
  const board = new PurFile(image, engine);
  try {
    assert.throws(() => underlying.run('DELETE FROM images'), /readonly/);
    const before = freed;
    assert.throws(() => board.rows('images'), /Simulated binding failure/);
    assert.equal(freed, before + 2); // table_info and SELECT both freed
  } finally {
    board.close();
  }
});

test('Unicode, NUL text, unknown columns and unverified comments retain raw values', () => {
  const board = new PurFile(
    changedDatabase(`
    ALTER TABLE items ADD COLUMN "extra" TEXT;
    UPDATE items SET name='Ω' || char(0) || '中', extra='hello', comment='unverified';
  `),
    SQL,
  );
  try {
    const row = board.rows('items')[0];
    assert.equal(row.name, 'Ω\0中');
    assert.equal(row.extra, 'hello');
    assert.equal(row.comment, 'unverified');
    assert.equal(board.decodedRows('items')[0].name, 'Ω\0中');
  } finally {
    board.close();
  }
});
