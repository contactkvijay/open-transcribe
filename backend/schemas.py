from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, HttpUrl


class GoogleAuthRequest(BaseModel):
    id_token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    name: Optional[str] = None
    picture: Optional[str] = None


class AuthResponse(BaseModel):
    access_token: str
    user: UserOut


class TranscribeRequest(BaseModel):
    url: HttpUrl
    mode: Literal["text", "audio", "both"] = "text"


class TranscribeResponse(BaseModel):
    history_id: int
    transcript: Optional[str] = None
    audio_url: Optional[str] = None
    title: Optional[str] = None
    duration_seconds: Optional[int] = None
    language: Optional[str] = None


class TranscriptSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_url: str
    title: Optional[str] = None
    duration_seconds: Optional[int] = None
    language: Optional[str] = None
    has_audio: bool = False
    created_at: datetime


class TranscriptDetail(TranscriptSummary):
    transcript: Optional[str] = None
    audio_url: Optional[str] = None
