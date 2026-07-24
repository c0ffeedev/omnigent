"""Index managed host session bindings for idle lifecycle scans.

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-07-24 10:00:00.000000

The managed-sandbox idle controller periodically resolves sessions bound to the
configured provider's hosts. Indexing ``(workspace_id, host_id, id)`` keeps that
join selective instead of scanning all conversation metadata every sweep.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "f5a6b7c8d9e0"
down_revision: str | None = "e4f5a6b7c8d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the managed host-binding lookup index."""
    op.create_index(
        "ix_conversation_metadata_host_id",
        "omnigent_conversation_metadata",
        ["workspace_id", "host_id", "id"],
    )


def downgrade() -> None:
    """Drop the managed host-binding lookup index."""
    op.drop_index(
        "ix_conversation_metadata_host_id",
        table_name="omnigent_conversation_metadata",
    )
