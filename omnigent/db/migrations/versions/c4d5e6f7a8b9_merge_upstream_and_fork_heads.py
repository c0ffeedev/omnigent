"""merge upstream and fork migration heads

Revision ID: c4d5e6f7a8b9
Revises: a6b7c8d9e0f1, b3c4d5e6f7a8
Create Date: 2026-07-24 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "c4d5e6f7a8b9"
down_revision: tuple[str, str] = ("a6b7c8d9e0f1", "b3c4d5e6f7a8")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Join the upstream and fork migration histories without schema changes."""


def downgrade() -> None:
    """Split the migration histories without schema changes."""
