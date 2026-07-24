"""Migration tests for persisted device-grant scopes."""

from __future__ import annotations

from pathlib import Path

import sqlalchemy as sa
from alembic import command

from omnigent.db.utils import _build_alembic_config

_PREVIOUS_REVISION = "f5a6b7c8d9e0"
_THIS_REVISION = "g6b7c8d9e0f1"


def test_device_grant_scope_upgrade_and_downgrade(tmp_path: Path) -> None:
    """The migration backfills legacy grants and is reversible."""
    db_path = tmp_path / "device-grant-scope.db"
    uri = f"sqlite:///{db_path}"
    engine = sa.create_engine(uri)
    config = _build_alembic_config(uri)

    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, _PREVIOUS_REVISION)

            columns = {
                column["name"]: column
                for column in sa.inspect(connection).get_columns("device_grants")
            }
            assert "scope" not in columns
            connection.execute(
                sa.text(
                    """
                    INSERT INTO device_grants (
                        id, device_code_hash, user_code, status, created_at, expires_at
                    ) VALUES (
                        'legacy-grant', :digest, 'ABCD-2345', 1, 1000, 1600
                    )
                    """
                ),
                {"digest": "a" * 64},
            )

            command.upgrade(config, _THIS_REVISION)
            columns = {
                column["name"]: column
                for column in sa.inspect(connection).get_columns("device_grants")
            }
            assert columns["scope"]["nullable"] is False
            scope = connection.execute(
                sa.text("SELECT scope FROM device_grants WHERE id = 'legacy-grant'")
            ).scalar_one()
            assert scope == "sessions"

            command.downgrade(config, _PREVIOUS_REVISION)
            columns = {
                column["name"]: column
                for column in sa.inspect(connection).get_columns("device_grants")
            }
            assert "scope" not in columns
    finally:
        engine.dispose()
