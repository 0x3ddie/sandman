from __future__ import annotations

import sqlite3
from pathlib import Path


class StateDatabase:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS records (
                    namespace TEXT NOT NULL,
                    record_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (namespace, record_id)
                )
                """
            )

    @property
    def path(self) -> Path:
        return self._path

    def save(self, namespace: str, record_id: str, payload: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO records (namespace, record_id, payload)
                VALUES (?, ?, ?)
                ON CONFLICT(namespace, record_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (namespace, record_id, payload),
            )

    def load(self, namespace: str, record_id: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM records WHERE namespace = ? AND record_id = ?",
                (namespace, record_id),
            ).fetchone()
        return str(row[0]) if row is not None else None

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._path, timeout=5)
