from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import (
    current_user,
    issue_jwt,
    upsert_user_from_claims,
    verify_google_id_token,
)
from db import get_db
from models import User
from schemas import AuthResponse, GoogleAuthRequest, UserOut

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/auth/google", response_model=AuthResponse)
def google_auth(req: GoogleAuthRequest, db: Session = Depends(get_db)):
    claims = verify_google_id_token(req.id_token)
    user = upsert_user_from_claims(db, claims)
    token = issue_jwt(user)
    return AuthResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return UserOut.model_validate(user)


@router.post("/logout")
def logout(_: User = Depends(current_user)):
    # JWTs are stateless; client deletes its own token. Server-side blocklist
    # would go here if needed in a later version.
    return {"ok": True}
