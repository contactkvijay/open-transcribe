import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from db import Base, SessionLocal, engine
from models import Transcript
from routers import auth as auth_router
from routers import history as history_router
from routers import transcribe as transcribe_router
from routers import x_tweet as x_tweet_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _purge_old_audio() -> None:
    cutoff = time.time() - settings.AUDIO_RETENTION_HOURS * 3600
    tmp_dir = Path(settings.TMP_AUDIO_DIR)
    if not tmp_dir.exists():
        return
    db = SessionLocal()
    try:
        for f in tmp_dir.iterdir():
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
                    logger.info("purged old audio: %s", f)
            except OSError as e:
                logger.warning("error purging %s: %s", f, e)
        # Clear DB rows pointing at vanished files.
        rows = db.query(Transcript).filter(Transcript.audio_path.isnot(None)).all()
        for r in rows:
            if r.audio_path and not Path(r.audio_path).exists():
                r.audio_path = None
        db.commit()
    finally:
        db.close()


_scheduler: BackgroundScheduler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    global _scheduler
    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(_purge_old_audio, "interval", hours=1, next_run_time=None)
    _scheduler.start()
    logger.info("backend up. db=%s, tmp=%s", settings.DB_PATH, settings.TMP_AUDIO_DIR)
    yield
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)


app = FastAPI(title="X Video Transcribe", lifespan=lifespan)


def _origin_regex() -> str:
    parts = [p.strip() for p in settings.ALLOWED_ORIGINS.split(",") if p.strip()]
    regexes = []
    for p in parts:
        if "*" in p:
            regexes.append(re.escape(p).replace(r"\*", ".*"))
        else:
            regexes.append(re.escape(p))
    return "^(" + "|".join(regexes) + ")$" if regexes else "^$"


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_origin_regex(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(transcribe_router.router)
app.include_router(history_router.router)
app.include_router(x_tweet_router.router)


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=True)
