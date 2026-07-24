"""fence managed host idle suspension

Revision ID: b28c39d40e51
Revises: a17b28c39d40
Create Date: 2026-07-24 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b28c39d40e51"
down_revision: str | None = "a17b28c39d40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add durable activity and suspension-claim fencing."""
    with op.batch_alter_table("hosts") as batch_op:
        batch_op.add_column(sa.Column("managed_activity_at", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("managed_activity_seq", sa.Integer(), nullable=False, server_default="0")
        )
        batch_op.add_column(sa.Column("wake_fence_expires_at", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("suspend_claim_owner", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("suspend_claim_expires_at", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Remove managed-host suspension fencing."""
    with op.batch_alter_table("hosts") as batch_op:
        batch_op.drop_column("suspend_claim_expires_at")
        batch_op.drop_column("suspend_claim_owner")
        batch_op.drop_column("wake_fence_expires_at")
        batch_op.drop_column("managed_activity_seq")
        batch_op.drop_column("managed_activity_at")
