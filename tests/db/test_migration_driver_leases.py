"""Migration validation for persisted session driver leases."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from sqlalchemy.exc import IntegrityError

from omnigent.db.utils import _build_alembic_config

_PRIOR_REVISION = "f5a6b7c8d9e0"
_THIS_REVISION = "a6b7c8d9e0f1"


def _migrate(engine: sa.Engine, uri: str, revision: str, *, downgrade: bool = False) -> None:
    config = _build_alembic_config(uri)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        operation = command.downgrade if downgrade else command.upgrade
        operation(config, revision)


def test_driver_lease_migration_round_trip(tmp_path: Path) -> None:
    """Upgrade creates lease/fencing schema and downgrade removes it."""
    uri = f"sqlite:///{tmp_path / 'driver-lease.db'}"
    engine = sa.create_engine(uri)
    try:
        _migrate(engine, uri, _PRIOR_REVISION)
        inspector = sa.inspect(engine)
        assert "session_driver_leases" not in inspector.get_table_names()
        assert "driver_generation" not in {
            column["name"] for column in inspector.get_columns("conversation_items")
        }

        _migrate(engine, uri, _THIS_REVISION)
        inspector = sa.inspect(engine)
        assert "session_driver_leases" in inspector.get_table_names()
        assert inspector.get_pk_constraint("session_driver_leases")["constrained_columns"] == [
            "workspace_id",
            "session_id",
        ]
        assert "driver_generation" in {
            column["name"] for column in inspector.get_columns("conversation_items")
        }
        _migrate(engine, uri, _PRIOR_REVISION, downgrade=True)
        inspector = sa.inspect(engine)
        assert "session_driver_leases" not in inspector.get_table_names()
        assert "driver_generation" not in {
            column["name"] for column in inspector.get_columns("conversation_items")
        }
    finally:
        engine.dispose()


def test_driver_lease_migration_enforces_lifecycle(tmp_path: Path) -> None:
    """The database rejects zero generations and impossible active rows."""
    uri = f"sqlite:///{tmp_path / 'driver-lease-constraints.db'}"
    engine = sa.create_engine(uri)
    try:
        _migrate(engine, uri, _THIS_REVISION)
        leases = sa.Table("session_driver_leases", sa.MetaData(), autoload_with=engine)
        valid = {
            "workspace_id": 0,
            "session_id": bytes.fromhex("112233445566478890abcdef12345678"),
            "holder_user_id": "alice@example.com",
            "generation": 1,
            "acquired_at": 100,
            "renewed_at": 100,
            "expires_at": 130,
            "released_at": None,
        }
        with engine.begin() as connection:
            connection.execute(leases.insert().values(**valid))

        invalid_rows = (
            {
                **valid,
                "session_id": bytes.fromhex("212233445566478890abcdef12345678"),
                "generation": 0,
            },
            {
                **valid,
                "session_id": bytes.fromhex("312233445566478890abcdef12345678"),
                "holder_user_id": None,
                "expires_at": 130,
                "released_at": 101,
            },
        )
        for row in invalid_rows:
            with pytest.raises(IntegrityError):
                with engine.begin() as connection:
                    connection.execute(leases.insert().values(**row))
    finally:
        engine.dispose()
