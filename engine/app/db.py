from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import ensure_storage_dirs, settings


ensure_storage_dirs()
engine = create_engine(f"sqlite:///{settings.sqlite_file}", future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db():
    session: Session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
