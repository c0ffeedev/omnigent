"""Add delegated authorization scope to device grants.

Revision ID: g6b7c8d9e0f1
Revises: b28c39d40e51
Create Date: 2026-07-24 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "g6b7c8d9e0f1"
down_revision: str | None = "b28c39d40e51"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Persist the scope selected during device authorization."""
    with op.batch_alter_table("device_grants") as batch:
        batch.add_column(
            sa.Column(
                "scope",
                sa.String(length=64),
                nullable=False,
                server_default="sessions",
            )
        )


def downgrade() -> None:
    """Remove persisted device-grant scope."""
    with op.batch_alter_table("device_grants") as batch:
        batch.drop_column("scope")
