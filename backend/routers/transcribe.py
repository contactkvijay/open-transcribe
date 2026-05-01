import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

import transcribe as transcribe_svc
import ytdl
from auth import current_user, sign_audio_token, verify_audio_token
from db import get_db
from models import Transcript, User
from schemas import TranscribeRequest, TranscribeResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["transcribe"])


@router.post("/transcribe", response_model=TranscribeResponse)
def do_transcribe(
    req: TranscribeRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    # Reuse a previous transcript for the same user+URL when it already covers
    # what was asked for, so re-clicking the button is instant.
    existing = (
        db.query(Transcript)
        .filter(Transcript.user_id == user.id, Transcript.source_url == str(req.url))
        .order_by(Transcript.created_at.desc())
        .first()
    )
    if existing is not None:
        has_text = bool(existing.transcript)
        has_audio = bool(existing.audio_path) and Path(existing.audio_path).exists()
        if (req.mode == "text" and has_text) or \
           (req.mode == "audio" and has_audio) or \
           (req.mode == "both" and has_text and has_audio):
            audio_url = None
            if req.mode in ("audio", "both") and has_audio:
                token = sign_audio_token(existing.id, user.id)
                audio_url = f"/api/audio/{token}"
            return TranscribeResponse(
                history_id=existing.id,
                transcript=existing.transcript if req.mode in ("text", "both") else None,
                audio_url=audio_url,
                title=existing.title,
                duration_seconds=existing.duration_seconds,
                language=existing.language,
            )

    try:
        audio = ytdl.extract_audio(str(req.url))
    except ytdl.DownloadError as e:
        raise HTTPException(400, f"Could not download video: {e}")

    transcript_text = None
    language = None
    if req.mode in ("text", "both"):
        try:
            result = transcribe_svc.transcribe_file(audio.path)
            transcript_text = result.text
            language = result.language
        except transcribe_svc.TranscribeError as e:
            try:
                audio.path.unlink(missing_ok=True)
            except OSError:
                pass
            raise HTTPException(502, f"Transcription failed: {e}")

    keep_audio = req.mode in ("audio", "both")
    row = Transcript(
        user_id=user.id,
        source_url=str(req.url),
        title=audio.title,
        duration_seconds=audio.duration_seconds,
        language=language,
        transcript=transcript_text,
        audio_path=str(audio.path) if keep_audio else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    if not keep_audio:
        try:
            audio.path.unlink(missing_ok=True)
        except OSError as e:
            logger.warning("could not delete temp audio %s: %s", audio.path, e)

    audio_url = None
    if keep_audio:
        token = sign_audio_token(row.id, user.id)
        audio_url = f"/api/audio/{token}"

    return TranscribeResponse(
        history_id=row.id,
        transcript=transcript_text,
        audio_url=audio_url,
        title=audio.title,
        duration_seconds=audio.duration_seconds,
        language=language,
    )


@router.get("/audio/{token}")
def download_audio(token: str, db: Session = Depends(get_db)):
    transcript_id, user_id = verify_audio_token(token)
    row = db.get(Transcript, transcript_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(404, "Audio not found")
    if not row.audio_path:
        raise HTTPException(404, "Audio was not retained for this transcript")
    path = Path(row.audio_path)
    if not path.exists():
        raise HTTPException(410, "Audio file has been cleaned up")
    filename = (row.title or f"transcribe-{row.id}").replace("/", "_") + ".mp3"
    return FileResponse(path, media_type="audio/mpeg", filename=filename)
