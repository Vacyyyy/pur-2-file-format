// Compile the consumer-facing declarations against the actual sql.js types.
import initSqlJs from 'sql.js';
import { PurFile, type Transform } from '../../dist/index.js';

async function consume(bytes: Uint8Array): Promise<void> {
  const SQL = await initSqlJs();
  const board = new PurFile(bytes, SQL);
  try {
    const imageBytes: Uint8Array | null = board.rows('images')[0].data;
    const rawTransform: string | Uint8Array | null = board.rows('items')[0].transform;
    const decoded = board.decodedRows('items')[0].transform;
    if (decoded?.kind === 'transform') {
      const matrix: Transform = decoded.value;
      void matrix;
    }
    if (decoded?.kind === 'undecoded') {
      const reason: string = decoded.error;
      void reason;
    }
    // @ts-expect-error Table names are restricted to the documented schema.
    board.rows('not_a_table');
    // @ts-expect-error Raw encoded image bytes are not text.
    const wrong: string = imageBytes;
    void rawTransform;
    void wrong;
  } finally {
    board.close();
  }
}
void consume;
