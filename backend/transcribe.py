"""Groq Whisper wrapper."""
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from groq import Groq

from config import settings

logger = logging.getLogger(__name__)


@dataclass
class TranscriptResult:
    text: str
    language: Optional[str]


class TranscribeError(Exception):
    pass


_client: Optional[Groq] = None


def _get_client() -> Groq:
    global _client
    if _client is None:
        if not settings.GROQ_API_KEY:
            raise TranscribeError("GROQ_API_KEY not configured")
        _client = Groq(api_key=settings.GROQ_API_KEY)
    return _client


def transcribe_file(path: Path) -> TranscriptResult:
    """Send audio file to Groq Whisper and return transcript text + detected language."""
    if not path.exists():
        raise TranscribeError(f"audio file missing: {path}")

    client = _get_client()
    with path.open("rb") as f:
        try:
            resp = client.audio.transcriptions.create(
                file=(path.name, f.read()),
                model=settings.GROQ_MODEL,
                response_format="verbose_json",
            )
        except Exception as e:
            raise TranscribeError(f"groq transcription failed: {e}") from e

    text = getattr(resp, "text", "") or ""
    language = getattr(resp, "language", None)
    return TranscriptResult(text=text.strip(), language=language)
