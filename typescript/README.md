# TypeScript reader

Read-only port of the Python reader for the **verified PureRef 2.1.3 subset**
(envelope `2.1`, SQLite schema `200101`). It reads bytes in memory and has no
filesystem, DOM, Obsidian, Python, or PureRef dependency at runtime. It does not
render boards or write `.pur` files.

## Build and use

From the repository root, with Node.js 20.19+:

```sh
npm ci
npm run build
```

The root package is private; it is not published to npm. Build output is ESM in
`dist/`, with TypeScript declarations. The only runtime package dependency is
`@noble/hashes`, used for the format's MD5 checksums (not authentication).

Initialize `sql.js` in the host application and pass it to the reader. This lets
an existing plugin reuse its SQLite engine and choose how to bundle/load WASM.
`sql.js` is a development dependency here for testing; consumers must supply it
or an engine implementing the exported `SqliteEngine` interface.

```ts
import initSqlJs from 'sql.js';
import { PurFile, unwrap } from './dist/index.js';

// In a browser, supply locateFile or wasmBinary for your deployment.
const SQL = await initSqlJs({ locateFile: file => `/assets/${file}` });
const bytes = new Uint8Array(await (await fetch('/boards/example.pur')).arrayBuffer());

// Header/thumbnail access needs no SQLite engine. Checksums are always checked.
const { header } = unwrap(bytes);
console.log(header.application_version, header.thumbnail, header.checksum_valid);

const board = new PurFile(bytes, SQL);
try {
  const resources = board.rows('images'); // data: Uint8Array | null
  const items = board.decodedRows('items');
  const instances = board.decodedRows('items_images');
  for (const item of items) {
    if (item.transform?.kind === 'transform') {
      console.log(item.id, item.parent, item.transform.value); // nine doubles
    }
  }
  console.log(resources.length, instances.length);
  console.log(board.inspect()); // Python-compatible diagnostic JSON shape
} finally {
  board.close();
}
```

For Node.js, initialize `sql.js` without `locateFile` and supply bytes from
`readFile`. The reader itself never imports Node modules. `npm run check:browser`
checks that the entry point bundles for a browser without Node shims; it is not
a browser rendering or Obsidian integration test.

## API and ownership

- `unwrap(Uint8Array | ArrayBuffer)` returns `{ header, database }`. It checks
  header bounds, reconstructs the displaced SQLite prefix, validates the SQLite
  signature/page geometry, and reports MD5 validity. It accepts subarray/Buffer
  views. Returned database and thumbnail buffers do not alias the input.
- `new PurFile(bytes, SQL)` also checks the SQLite application ID/schema version
  and enables `query_only`. Unsupported schemas are rejected rather than guessed.
- `rows(table)` returns typed raw cells for the seven documented tables. Extra
  columns are retained. TEXT is fetched as UTF-8 bytes before decoding because
  `sql.js`'s ordinary string conversion truncates embedded NULs. Qt's serialized
  text remains a string here; use `binary()` to recover its Latin-1 bytes.
- `decodedRows(table)` additionally decodes the table's Qt variant columns.
  Each decoded variant has a `kind` discriminator (`transform`, `rect`, `size`,
  `path`, `strokes`, `rational`, or `unknown`). Unsupported or malformed binary
  payloads become `{ kind: 'undecoded', raw_hex, error }`. Non-Latin-1 text in a
  serialized cell is invalid and raises `FormatError`; raw `rows()` is still
  available for diagnosis.
- `decodeVariant(value)` decodes one cell and throws `FormatError` for malformed
  or unsupported encodings. `tryDecodeVariant(value)` retains those bytes as an
  `undecoded` result. Unknown type IDs/custom names retain `payload_hex`; unused
  trailing bytes retain `tail_hex`. SQL NULL produces `null`. The serialized Qt
  `is_null` flag is preserved independently; consumers must respect it.
- `inspect()` returns the Python reader's diagnostic structure, without the TS
  `kind` discriminator. It runs SQLite integrity checking and summarizes BLOBs
  by length/MD5. Use `rows()` for actual image/thumbnail bytes.
- `close()` is idempotent and releases the database. Rows and byte buffers already
  returned remain valid. Reads after closing fail. Close the board in `finally`.

Tables are not joined, reordered, or flattened. Image resources and image items
have separate IDs; `items_images.image` references `images.id`. Parent transforms,
crop paths, opacity, `z`, and sibling ordering remain available to a renderer.
Do not assume parents appear before children. Notes contain **untrusted Qt HTML**;
a viewer must sanitize/adapt it before inserting it into the DOM. This reader
does not execute HTML, fetch linked resources, or interpret unknown flags.

The implementation loads files and SQLite into memory. Callers should impose
file/image limits appropriate to their application. SQLite integers outside
JavaScript's safe integer range are rejected instead of silently rounded. Unknown
BigRational encodings retain raw words/payloads, not guessed ordering values.

Checksum mismatches are diagnostic (`checksum_valid: false`), as in Python, and
do not prevent reading an otherwise valid database. Structural/schema errors
reject the file. This is intentionally stricter than Python for unknown database
versions and unsafe integers. Other PureRef releases, linked resources, animation,
and unverified drawing options retain the limitations in [FORMAT.md](../FORMAT.md).

## Tests

```sh
npm test
npm run check:browser
python -m unittest discover -s tests -v
```

Tests require Python 3.11+ with SQLite serialization support, solely as the
reference implementation. Set `PYTHON` to its executable path if it is not named
`python`. Every checked-in `.pur` fixture in `investigation/` plus the standalone
demo is compared against Python: reconstructed database checksum, every raw row,
and complete `inspect()` output. Additional cases cover malformed input, unknown
variants, binary text preservation, schema checks, ownership, and cleanup.
Consumer types are checked against the actual `sql.js` declarations.
