"""add project resources

Revision ID: a7b8c9d0e1f2
Revises: f5a6b7c8d9e0
Create Date: 2026-07-24 00:00:00.000000

Extends first-class Projects with lightweight typed references to repositories,
tasks, decisions, and open questions. Sessions keep using the existing
``omnigent_conversation_metadata.project_id`` relationship; this migration does
not introduce a parallel workset or duplicate session membership.

The project relationship is application-managed without a database foreign key
(schema Rule R032). The project store removes associated rows when deleting a
project.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "a7b8c9d0e1f2"
down_revision: str | None = "f5a6b7c8d9e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``project_resources`` association table."""
    op.create_table(
        "project_resources",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("project_id", Uuid16(), nullable=False),
        # Stable codes: repository=1, task=2, decision=3, open_question=4.
        sa.Column("kind", sa.SmallInteger(), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("reference", sa.String(2048), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("kind IN (1, 2, 3, 4)", name="ck_project_resources_kind"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_project_resources_project_id",
        "project_resources",
        ["workspace_id", "project_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop project resource associations."""
    op.drop_index("ix_project_resources_project_id", table_name="project_resources")
    op.drop_table("project_resources")
