"""Migration validation for persisted session driver leases."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy.exc import IntegrityError

from omnigent.db.utils import _build_alembic_config

_PRIOR_REVISION = "g6b7c8d9e0f1"
_THIS_REVISION = "a6b7c8d9e0f1"
_OUTBOX_REVISION = "b7c8d9e0f1a2"


def test_driver_outbox_migration_is_the_single_head(tmp_path: Path) -> None:
    """The outbox migration extends the merged graph without creating a branch."""
    uri = f"sqlite:///{tmp_path / 'heads.db'}"
    script = ScriptDirectory.from_config(_build_alembic_config(uri))
    assert script.get_heads() == [_OUTBOX_REVISION]


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
        assert "session_driver_events" not in inspector.get_table_names()
        assert "session_driver_dispatches" not in inspector.get_table_names()
        assert "driver_generation" not in {
            column["name"] for column in inspector.get_columns("conversation_items")
        }

        _migrate(engine, uri, _THIS_REVISION)
        inspector = sa.inspect(engine)
        assert "session_driver_leases" in inspector.get_table_names()
        assert "session_driver_events" in inspector.get_table_names()
        assert "session_driver_dispatches" in inspector.get_table_names()
        dispatch_columns = {
            column["name"]: column for column in inspector.get_columns("session_driver_dispatches")
        }
        for column_name in (
            "payload_json",
            "event_id",
            "source_id",
            "effect_id",
            "consumer_token",
            "consumer_generation",
        ):
            assert dispatch_columns[column_name]["nullable"] is False
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
        assert "session_driver_events" not in inspector.get_table_names()
        assert "session_driver_dispatches" not in inspector.get_table_names()
        assert "driver_generation" not in {
            column["name"] for column in inspector.get_columns("conversation_items")
        }

        _migrate(engine, uri, _THIS_REVISION)
        inspector = sa.inspect(engine)
        assert "session_driver_leases" in inspector.get_table_names()
        assert "session_driver_events" in inspector.get_table_names()
        assert "session_driver_dispatches" in inspector.get_table_names()
        assert "driver_generation" in {
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

        dispatches = sa.Table(
            "session_driver_dispatches",
            sa.MetaData(),
            autoload_with=engine,
        )
        valid_dispatch = {
            "workspace_id": 0,
            "id": bytes.fromhex("412233445566478890abcdef12345678"),
            "session_id": bytes.fromhex("112233445566478890abcdef12345678"),
            "actor_user_id": "alice@example.com",
            "generation": 1,
            "input_type": "message",
            "payload_json": '{"data":{},"type":"message"}',
            "event_id": bytes.fromhex("812233445566478890abcdef12345678"),
            "source_id": "event-1",
            "effect_id": "effect-1",
            "consumer_token": bytes.fromhex("912233445566478890abcdef12345678"),
            "consumer_generation": 1,
            "state": "running",
            "created_at": 100,
            "completed_at": None,
            "claim_expires_at": 130,
        }
        with engine.begin() as connection:
            connection.execute(dispatches.insert().values(**valid_dispatch))

        invalid_dispatches = (
            {
                **valid_dispatch,
                "id": bytes.fromhex("512233445566478890abcdef12345678"),
                "source_id": "event-2",
                "claim_expires_at": None,
            },
            {
                **valid_dispatch,
                "id": bytes.fromhex("612233445566478890abcdef12345678"),
                "source_id": "event-3",
                "state": "completed",
                "completed_at": 101,
            },
            {
                **valid_dispatch,
                "id": bytes.fromhex("712233445566478890abcdef12345678"),
                "source_id": "event-4",
                "claim_expires_at": 100,
            },
        )
        for row in invalid_dispatches:
            with pytest.raises(IntegrityError):
                with engine.begin() as connection:
                    connection.execute(dispatches.insert().values(**row))
    finally:
        engine.dispose()


def test_driver_outbox_migration_preserves_claims_and_round_trips_pending_work(
    tmp_path: Path,
) -> None:
    """Existing claims survive upgrade; downgrade maps new states to the old lifecycle."""
    uri = f"sqlite:///{tmp_path / 'driver-outbox.db'}"
    engine = sa.create_engine(uri)
    session_id = bytes.fromhex("112233445566478890abcdef12345678")
    running_id = bytes.fromhex("212233445566478890abcdef12345678")
    pending_id = bytes.fromhex("312233445566478890abcdef12345678")
    executing_id = bytes.fromhex("412233445566478890abcdef12345678")
    try:
        _migrate(engine, uri, _THIS_REVISION)
        dispatches = sa.Table(
            "session_driver_dispatches",
            sa.MetaData(),
            autoload_with=engine,
        )
        with engine.begin() as connection:
            connection.execute(
                dispatches.insert().values(
                    workspace_id=0,
                    id=running_id,
                    session_id=session_id,
                    actor_user_id="alice@example.com",
                    generation=1,
                    input_type="message",
                    payload_json='{"data":{},"type":"message"}',
                    event_id=bytes.fromhex("512233445566478890abcdef12345678"),
                    source_id="pre-outbox-claim",
                    effect_id="effect-pre-outbox",
                    consumer_token=bytes.fromhex("612233445566478890abcdef12345678"),
                    consumer_generation=1,
                    state="running",
                    created_at=100,
                    completed_at=None,
                    claim_expires_at=130,
                )
            )

        _migrate(engine, uri, _OUTBOX_REVISION)
        inspector = sa.inspect(engine)
        dispatch_columns = {
            column["name"]: column for column in inspector.get_columns("session_driver_dispatches")
        }
        assert dispatch_columns["consumer_token"]["nullable"] is True
        assert dispatch_columns["consumer_generation"]["nullable"] is False

        dispatches = sa.Table(
            "session_driver_dispatches",
            sa.MetaData(),
            autoload_with=engine,
        )
        with engine.begin() as connection:
            running = (
                connection.execute(sa.select(dispatches).where(dispatches.c.id == running_id))
                .mappings()
                .one()
            )
            assert running["state"] == "running"
            assert running["consumer_generation"] == 1
            assert running["claim_expires_at"] == 130
            connection.execute(
                dispatches.insert(),
                [
                    {
                        "workspace_id": 0,
                        "id": pending_id,
                        "session_id": session_id,
                        "actor_user_id": "alice@example.com",
                        "generation": 1,
                        "input_type": "message",
                        "payload_json": '{"data":{"text":"pending"},"type":"message"}',
                        "event_id": bytes.fromhex("712233445566478890abcdef12345678"),
                        "source_id": "pending-work",
                        "effect_id": "effect-pending",
                        "consumer_token": None,
                        "consumer_generation": 0,
                        "state": "pending",
                        "created_at": 101,
                        "completed_at": None,
                        "claim_expires_at": None,
                    },
                    {
                        "workspace_id": 0,
                        "id": executing_id,
                        "session_id": session_id,
                        "actor_user_id": "alice@example.com",
                        "generation": 1,
                        "input_type": "message",
                        "payload_json": '{"data":{"text":"executing"},"type":"message"}',
                        "event_id": bytes.fromhex("812233445566478890abcdef12345678"),
                        "source_id": "executing-work",
                        "effect_id": "effect-executing",
                        "consumer_token": bytes.fromhex("912233445566478890abcdef12345678"),
                        "consumer_generation": 2,
                        "state": "executing",
                        "created_at": 102,
                        "completed_at": None,
                        "claim_expires_at": 132,
                    },
                ],
            )

        _migrate(engine, uri, _THIS_REVISION, downgrade=True)
        dispatches = sa.Table(
            "session_driver_dispatches",
            sa.MetaData(),
            autoload_with=engine,
        )
        with engine.connect() as connection:
            rows = {
                row["source_id"]: row
                for row in connection.execute(sa.select(dispatches)).mappings()
            }
        assert rows["pre-outbox-claim"]["state"] == "running"
        assert rows["executing-work"]["state"] == "running"
        assert rows["pending-work"]["state"] == "failed"
        assert rows["pending-work"]["consumer_token"] is not None
        assert rows["pending-work"]["consumer_generation"] == 1
        assert rows["pending-work"]["completed_at"] >= 101

        _migrate(engine, uri, _OUTBOX_REVISION)
        dispatches = sa.Table(
            "session_driver_dispatches",
            sa.MetaData(),
            autoload_with=engine,
        )
        with engine.connect() as connection:
            pending = (
                connection.execute(
                    sa.select(dispatches).where(dispatches.c.source_id == "pending-work")
                )
                .mappings()
                .one()
            )
        assert pending["state"] == "failed"
        assert pending["consumer_generation"] == 1
    finally:
        engine.dispose()
