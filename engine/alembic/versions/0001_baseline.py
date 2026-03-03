"""baseline schema

Revision ID: 0001_baseline
Revises:
Create Date: 2026-03-01 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "prompt_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("template", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_prompt_templates_name", "prompt_templates", ["name"], unique=True)

    op.create_table(
        "records",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("image_path", sa.String(length=512), nullable=False),
        sa.Column("ocr_text", sa.Text(), nullable=True),
        sa.Column("model_text", sa.Text(), nullable=True),
        sa.Column("model_raw", sa.JSON(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("searchable_text", sa.Text(), nullable=False),
        sa.Column("embedding_id", sa.String(length=256), nullable=True),
        sa.Column("prompt_template_id", sa.Integer(), sa.ForeignKey("prompt_templates.id"), nullable=True),
        sa.Column("prompt_template_name", sa.String(length=100), nullable=True),
        sa.Column("prompt_text", sa.Text(), nullable=False),
    )

    op.create_table(
        "analysis_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("record_id", sa.Integer(), sa.ForeignKey("records.id"), nullable=True),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("retry_count", sa.Integer(), nullable=False),
        sa.Column("error_message", sa.String(length=1024), nullable=True),
        sa.Column("request_metadata", sa.JSON(), nullable=False),
        sa.Column("retryable", sa.Boolean(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("analysis_runs")
    op.drop_table("records")
    op.drop_index("ix_prompt_templates_name", table_name="prompt_templates")
    op.drop_table("prompt_templates")
