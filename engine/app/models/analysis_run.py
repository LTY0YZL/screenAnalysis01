from __future__ import annotations

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import relationship

from app.db import Base


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"

    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    record_id = Column(Integer, ForeignKey("records.id"), nullable=True)
    provider = Column(String(64), nullable=False)
    model_name = Column(String(128), nullable=False)
    latency_ms = Column(Integer, nullable=False, default=0)
    status = Column(String(32), nullable=False, default="success")
    retry_count = Column(Integer, nullable=False, default=0)
    error_message = Column(String(1024), nullable=True)
    request_metadata = Column(JSON, nullable=False, default=dict)
    retryable = Column(Boolean, nullable=False, default=False)

    record = relationship("Record", back_populates="analysis_runs")
