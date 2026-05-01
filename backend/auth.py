"""Auth: verify Google id_token, mint our own JWT, FastAPI dep for current user."""
import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt as pyjwt
from fastapi import Depends, Header, HTTPException, status
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy.orm import Session

from config import settings
from db import get_db
from models import User

_GOOGLE_REQUEST = google_requests.Request()


def verify_google_id_token(token: str) -> dict:
    """Verify a Google id_token and return its claims, or raise HTTPException."""
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(500, "GOOGLE_CLIENT_ID not configured")
    try:
        claims = google_id_token.verify_oauth2_token(
            token, _GOOGLE_REQUEST, settings.GOOGLE_CLIENT_ID
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid Google token: {e}")
    if claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad token issuer")
    return claims


def upsert_user_from_claims(db: Session, claims: dict) -> User:
    sub = claims["sub"]
    user = db.query(User).filter(User.google_sub == sub).one_or_none()
    if user is None:
        user = User(
            google_sub=sub,
            email=claims.get("email", ""),
            name=claims.get("name"),
            picture=claims.get("picture"),
        )
        db.add(user)
    else:
        user.email = claims.get("email", user.email)
        user.name = claims.get("name", user.name)
        user.picture = claims.get("picture", user.picture)
    db.commit()
    db.refresh(user)
    return user


def issue_jwt(user: User) -> str:
    if not settings.JWT_SECRET:
        raise HTTPException(500, "JWT_SECRET not configured")
    now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=settings.JWT_EXPIRE_DAYS)).timestamp()),
    }
    return pyjwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


def _decode_jwt(token: str) -> dict:
    try:
        return pyjwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid session token")


def current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    payload = _decode_jwt(token)
    user_id = int(payload["sub"])
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return user


def sign_audio_token(transcript_id: int, user_id: int, ttl_seconds: Optional[int] = None) -> str:
    """HMAC-signed short-lived URL token: <transcript_id>.<user_id>.<exp>.<sig>"""
    ttl = ttl_seconds or settings.AUDIO_URL_TTL_SECONDS
    exp = int(time.time()) + ttl
    msg = f"{transcript_id}.{user_id}.{exp}".encode()
    sig = hmac.new(settings.JWT_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    return f"{transcript_id}.{user_id}.{exp}.{sig}"


def verify_audio_token(token: str) -> tuple[int, int]:
    """Return (transcript_id, user_id) if valid, else raise."""
    try:
        tid_s, uid_s, exp_s, sig = token.split(".")
        tid, uid, exp = int(tid_s), int(uid_s), int(exp_s)
    except (ValueError, AttributeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Malformed audio token")
    if exp < int(time.time()):
        raise HTTPException(status.HTTP_410_GONE, "Audio link expired")
    msg = f"{tid}.{uid}.{exp}".encode()
    expected = hmac.new(settings.JWT_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Bad audio token signature")
    return tid, uid
