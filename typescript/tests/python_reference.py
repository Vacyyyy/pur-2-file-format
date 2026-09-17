"""Emit reference results for TS parity tests; never writes fixture files."""
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from pureref2 import PurFile


def raw_value(value):
    return {"hex": value.hex()} if isinstance(value, bytes) else value


results = {}
for filename in sys.argv[1:]:
    board = PurFile.read(filename)
    try:
        results[filename] = {
            "inspect": board.inspect(),
            "database_md5": hashlib.md5(board.database).hexdigest(),
            "rows": {
                table: [{key: raw_value(value) for key, value in row.items()}
                        for row in board.rows(table)]
                for table in ("images", "metadata", "items", "items_images",
                              "items_notes", "items_groups", "items_drawings")
            },
        }
    finally:
        board.close()
print(json.dumps(results, ensure_ascii=True))
