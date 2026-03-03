from __future__ import annotations

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import relationship

from app.db import Base


class Record(Base):
    __tablename__ = "records"

    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    image_path = Column(String(512), nullable=False)
    ocr_text = Column(Text, nullable=True)
    model_text = Column(Text, nullable=True)
    model_raw = Column(JSON, nullable=True)
    metadata_json = Column(JSON, nullable=False, default=dict)
    searchable_text = Column(Text, nullable=False, default="")
    embedding_id = Column(String(256), nullable=True)

    prompt_template_id = Column(Integer, ForeignKey("prompt_templates.id"), nullable=True)
    prompt_template_name = Column(String(100), nullable=True)
    prompt_text = Column(Text, nullable=False, default="")

    prompt_template = relationship("PromptTemplate", back_populates="records")
    analysis_runs = relationship("AnalysisRun", back_populates="record")
