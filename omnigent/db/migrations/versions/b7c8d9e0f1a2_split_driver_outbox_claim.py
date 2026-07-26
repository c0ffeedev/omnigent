"""Split durable driver outbox acceptance from consumer claiming.

Revision ID: b7c8d9e0f1a2
Revises: c4d5e6f7a8b9
"""

import time
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "b7c8d9e0f1a2"
down_revision: str | None = "c4d5e6f7a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _repair_deployed_legacy_schema() -> None:
    """Repair databases that ran an earlier in-place version of a6b7c8d9e0f1."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    event_columns = {column["name"] for column in inspector.get_columns("session_driver_events")}
    if "source_id" not in event_columns:
        with op.batch_alter_table("session_driver_events") as batch_op:
            batch_op.add_column(sa.Column("source_id", sa.String(length=128), nullable=True))

    inspector = sa.inspect(bind)
    dispatch_columns = {
        column["name"]: column for column in inspector.get_columns("session_driver_dispatches")
    }
    required_columns = {
        "payload_json": sa.Text(),
        "event_id": Uuid16(),
        "source_id": sa.String(length=128),
        "effect_id": sa.String(length=128),
        "consumer_token": Uuid16(),
        "consumer_generation": sa.Integer(),
    }
    missing_columns = {
        name: column_type
        for name, column_type in required_columns.items()
        if name not in dispatch_columns
    }
    if missing_columns:
        with op.batch_alter_table("session_driver_dispatches") as batch_op:
            for name, column_type in missing_columns.items():
                batch_op.add_column(sa.Column(name, column_type, nullable=True))

    inspector = sa.inspect(bind)
    dispatch_columns = {
        column["name"]: column for column in inspector.get_columns("session_driver_dispatches")
    }
    needs_backfill = bool(missing_columns) or any(
        dispatch_columns[name]["nullable"]
        for name in (
            "payload_json",
            "event_id",
            "source_id",
            "effect_id",
            "consumer_token",
            "consumer_generation",
        )
    )
    dispatches = sa.table(
        "session_driver_dispatches",
        sa.column("workspace_id", sa.Integer()),
        sa.column("id", Uuid16()),
        sa.column("state", sa.String()),
        sa.column("input_type", sa.String()),
        sa.column("payload_json", sa.Text()),
        sa.column("event_id", Uuid16()),
        sa.column("source_id", sa.String()),
        sa.column("effect_id", sa.String()),
        sa.column("consumer_token", Uuid16()),
        sa.column("consumer_generation", sa.Integer()),
        sa.column("completed_at", sa.Integer()),
        sa.column("claim_expires_at", sa.Integer()),
    )
    if needs_backfill:
        now = int(time.time())
        rows = bind.execute(sa.select(dispatches)).mappings().all()
        for row in rows:
            row_id = row["id"]
            legacy_id = row_id if isinstance(row_id, str) else bytes(row_id).hex()
            values: dict[str, object] = {}
            if row["payload_json"] is None:
                values["payload_json"] = '{"data":{},"type":"legacy-unrecoverable"}'
            if row["event_id"] is None:
                values["event_id"] = row_id
            if row["source_id"] is None:
                values["source_id"] = f"legacy:{legacy_id}"
            if row["effect_id"] is None:
                values["effect_id"] = f"legacy:{legacy_id}"
            if row["consumer_token"] is None:
                values["consumer_token"] = row_id
            if row["consumer_generation"] is None:
                values["consumer_generation"] = 1
            if values and row["state"] == "running":
                # The legacy row did not retain enough payload/identity data to resume safely.
                values.update(state="failed", completed_at=now, claim_expires_at=None)
            if values:
                op.execute(
                    dispatches.update()
                    .where(dispatches.c.workspace_id == row["workspace_id"])
                    .where(dispatches.c.id == row["id"])
                    .values(**values)
                )

    inspector = sa.inspect(bind)
    nullable_columns = {
        column["name"]
        for column in inspector.get_columns("session_driver_dispatches")
        if column["nullable"]
    }
    unique_constraints = {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("session_driver_dispatches")
    }
    with op.batch_alter_table("session_driver_dispatches") as batch_op:
        for name in ("payload_json", "event_id", "source_id", "effect_id", "consumer_generation"):
            if name in nullable_columns:
                batch_op.alter_column(name, existing_type=required_columns[name], nullable=False)
        if "uq_session_driver_dispatches_source" not in unique_constraints:
            batch_op.create_unique_constraint(
                "uq_session_driver_dispatches_source",
                ["workspace_id", "session_id", "source_id"],
            )


def upgrade() -> None:
    """Permit unclaimed pending outbox rows while preserving B2 claims."""
    _repair_deployed_legacy_schema()
    check_constraints = {
        constraint["name"]
        for constraint in sa.inspect(op.get_bind()).get_check_constraints(
            "session_driver_dispatches"
        )
    }
    with op.batch_alter_table("session_driver_dispatches") as batch_op:
        if "ck_session_driver_dispatches_consumer_generation_positive" in check_constraints:
            batch_op.drop_constraint(
                "ck_session_driver_dispatches_consumer_generation_positive",
                type_="check",
            )
        if "ck_session_driver_dispatches_state" in check_constraints:
            batch_op.drop_constraint("ck_session_driver_dispatches_state", type_="check")
        if "ck_session_driver_dispatches_lifecycle" in check_constraints:
            batch_op.drop_constraint("ck_session_driver_dispatches_lifecycle", type_="check")
        batch_op.alter_column(
            "consumer_token",
            existing_type=Uuid16(),
            nullable=True,
        )
        batch_op.create_check_constraint(
            "ck_session_driver_dispatches_consumer_generation_nonnegative",
            "consumer_generation >= 0",
        )
        batch_op.create_check_constraint(
            "ck_session_driver_dispatches_state",
            "state IN ('pending', 'running', 'executing', 'completed', 'failed')",
        )
        batch_op.create_check_constraint(
            "ck_session_driver_dispatches_lifecycle",
            "(state = 'pending' AND consumer_token IS NULL AND consumer_generation = 0 "
            "AND completed_at IS NULL AND claim_expires_at IS NULL) OR "
            "(state = 'running' AND consumer_token IS NOT NULL AND consumer_generation > 0 "
            "AND completed_at IS NULL AND claim_expires_at IS NOT NULL) OR "
            "(state = 'executing' AND consumer_token IS NOT NULL AND consumer_generation > 0 "
            "AND completed_at IS NULL AND claim_expires_at IS NOT NULL) OR "
            "(state IN ('completed', 'failed') AND completed_at IS NOT NULL "
            "AND claim_expires_at IS NULL)",
        )


def downgrade() -> None:
    """Restore the B2 always-claimed dispatch schema."""
    now = sa.func.extract("epoch", sa.func.current_timestamp()).cast(sa.Integer)
    dispatches = sa.table(
        "session_driver_dispatches",
        sa.column("state", sa.String()),
        sa.column("consumer_token", Uuid16()),
        sa.column("consumer_generation", sa.Integer()),
        sa.column("completed_at", sa.Integer()),
        sa.column("claim_expires_at", sa.Integer()),
    )
    op.execute(
        dispatches.update()
        .where(dispatches.c.state == "pending")
        .values(
            state="failed",
            consumer_token="00000000000000000000000000000000",
            consumer_generation=1,
            completed_at=now,
            claim_expires_at=None,
        )
    )
    op.execute(
        dispatches.update()
        .where(dispatches.c.consumer_token.is_(None))
        .values(consumer_token="00000000000000000000000000000000")
    )
    op.execute(
        dispatches.update()
        .where(dispatches.c.consumer_generation < 1)
        .values(consumer_generation=1)
    )
    op.execute(
        dispatches.update().where(dispatches.c.state == "executing").values(state="running")
    )
    with op.batch_alter_table("session_driver_dispatches") as batch_op:
        batch_op.drop_constraint(
            "ck_session_driver_dispatches_consumer_generation_nonnegative",
            type_="check",
        )
        batch_op.drop_constraint("ck_session_driver_dispatches_state", type_="check")
        batch_op.drop_constraint("ck_session_driver_dispatches_lifecycle", type_="check")
        batch_op.alter_column(
            "consumer_token",
            existing_type=Uuid16(),
            nullable=False,
        )
        batch_op.create_check_constraint(
            "ck_session_driver_dispatches_consumer_generation_positive",
            "consumer_generation > 0",
        )
        batch_op.create_check_constraint(
            "ck_session_driver_dispatches_state",
            "state IN ('running', 'completed', 'failed')",
        )
        batch_op.create_check_constraint(
            "ck_session_driver_dispatches_lifecycle",
            "(state = 'running' AND completed_at IS NULL AND claim_expires_at IS NOT NULL) OR "
            "(state IN ('completed', 'failed') AND completed_at IS NOT NULL "
            "AND claim_expires_at IS NULL)",
        )
