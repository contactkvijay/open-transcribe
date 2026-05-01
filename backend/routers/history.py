import os
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from auth import current_user, sign_audio_token
from db import get_db
from models import Transcript, User
from schemas import TranscriptDetail, TranscriptSummary

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history", response_model=List[TranscriptSummary])
def list_history(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Transcript)
        .filter(Transcript.user_id == user.id)
        .order_by(Transcript.created_at.desc())
        .limit(limit)
        .offset(offset)
        .all()
    )
    return [
        TranscriptSummary(
            id=r.id,
            source_url=r.source_url,
            title=r.title,
            duration_seconds=r.duration_seconds,
            language=r.language,
            has_audio=bool(r.audio_path and os.path.exists(r.audio_path)),
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.get("/history/{transcript_id}", response_model=TranscriptDetail)
def get_history(
    transcript_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    row = db.get(Transcript, transcript_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Not found")
    audio_url = None
    if row.audio_path and os.path.exists(row.audio_path):
        token = sign_audio_token(row.id, user.id)
        audio_url = f"/api/audio/{token}"
    return TranscriptDetail(
        id=row.id,
        source_url=row.source_url,
        title=row.title,
        duration_seconds=row.duration_seconds,
        language=row.language,
        has_audio=bool(audio_url),
        created_at=row.created_at,
        transcript=row.transcript,
        audio_url=audio_url,
    )


@router.delete("/history/{transcript_id}")
def delete_history(
    transcript_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    row = db.get(Transcript, transcript_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Not found")
    if row.audio_path:
        try:
            os.remove(row.audio_path)
        except OSError:
            pass
    db.delete(row)
    db.commit()
    return {"ok": True}
