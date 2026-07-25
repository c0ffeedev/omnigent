"""Split durable driver outbox acceptance from consumer claiming.

Revision ID: b7c8d9e0f1a2
Revises: c4d5e6f7a8b9
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "b7c8d9e0f1a2"
down_revision: str | None = "c4d5e6f7a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Permit unclaimed pending outbox rows while preserving B2 claims."""
    with op.batch_alter_table("session_driver_dispatches") as batch_op:
        batch_op.drop_constraint(
            "ck_session_driver_dispatches_consumer_generation_positive",
            type_="check",
        )
        batch_op.drop_constraint("ck_session_driver_dispatches_state", type_="check")
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
