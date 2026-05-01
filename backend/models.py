from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import relationship

from db import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    google_sub = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, index=True, nullable=False)
    name = Column(String)
    picture = Column(String)
    created_at = Column(DateTime, server_default=func.now())

    transcripts = relationship("Transcript", back_populates="user", cascade="all, delete-orphan")


class Transcript(Base):
    __tablename__ = "transcripts"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    source_url = Column(String, nullable=False)
    title = Column(String, nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    language = Column(String, nullable=True)
    transcript = Column(Text, nullable=True)
    audio_path = Column(String, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)

    user = relationship("User", back_populates="transcripts")
