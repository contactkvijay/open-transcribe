"""yt-dlp wrapper: extract audio (MP3) + metadata from a video URL."""
import logging
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yt_dlp

from config import settings

logger = logging.getLogger(__name__)


@dataclass
class AudioResult:
    path: Path
    title: Optional[str]
    duration_seconds: Optional[int]
    extractor: Optional[str]


class DownloadError(Exception):
    pass


def extract_audio(url: str) -> AudioResult:
    """Download the source media via yt-dlp and emit an MP3.

    For x.com/twitter the video and audio are usually muxed in one stream;
    yt-dlp grabs that stream and ffmpeg strips the audio to MP3. The
    intermediate video file is removed by yt-dlp's post-processor.
    """
    out_id = uuid.uuid4().hex
    out_template = str(Path(settings.TMP_AUDIO_DIR) / f"{out_id}.%(ext)s")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        # YouTube's "n parameter" challenge requires a JS runtime (deno)
        # plus this remote-component script. Without it, only image
        # formats are extractable for many YouTube videos.
        "remote_components": ["ejs:github"],
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "64",
            }
        ],
    }
    if settings.YTDL_COOKIES_PATH and Path(settings.YTDL_COOKIES_PATH).exists():
        ydl_opts["cookiefile"] = settings.YTDL_COOKIES_PATH

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(f"yt-dlp failed: {e}") from e

    final_path = Path(settings.TMP_AUDIO_DIR) / f"{out_id}.mp3"
    if not final_path.exists():
        # Some extractors produce different extensions; fall back to globbing.
        candidates = list(Path(settings.TMP_AUDIO_DIR).glob(f"{out_id}.*"))
        if not candidates:
            raise DownloadError("yt-dlp produced no output file")
        final_path = candidates[0]

    duration = info.get("duration")
    return AudioResult(
        path=final_path,
        title=info.get("title"),
        duration_seconds=int(duration) if duration else None,
        extractor=info.get("extractor"),
    )
