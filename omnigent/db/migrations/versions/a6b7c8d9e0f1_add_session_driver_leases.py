"""add persisted session driver leases and fencing attribution

Revision ID: a6b7c8d9e0f1
Revises: f5a6b7c8d9e0
Create Date: 2026-07-24 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "a6b7c8d9e0f1"
down_revision: str | None = "f5a6b7c8d9e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create lease/audit tables and stamp accepted human inputs."""
    op.create_table(
        "session_driver_leases",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("session_id", Uuid16(), nullable=False),
        sa.Column("holder_user_id", sa.String(128), nullable=True),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("acquired_at", sa.Integer(), nullable=True),
        sa.Column("renewed_at", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.Integer(), nullable=True),
        sa.Column("released_at", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "generation > 0", name="ck_session_driver_leases_generation_positive"
        ),
        sa.CheckConstraint(
            "(holder_user_id IS NULL AND expires_at IS NULL AND released_at IS NOT NULL) "
            "OR (holder_user_id IS NOT NULL AND acquired_at IS NOT NULL "
            "AND renewed_at IS NOT NULL AND expires_at IS NOT NULL AND released_at IS NULL)",
            name="ck_session_driver_leases_lifecycle",
        ),
        sa.PrimaryKeyConstraint("workspace_id", "session_id"),
    )
    with op.batch_alter_table("conversation_items") as batch_op:
        batch_op.add_column(sa.Column("driver_generation", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Remove persisted driver leases and fencing attribution."""
    with op.batch_alter_table("conversation_items") as batch_op:
        batch_op.drop_column("driver_generation")
    op.drop_table("session_driver_leases")
