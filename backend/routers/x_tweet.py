"""Server-side X tweet fetcher.

Used by the bookmarks extension as a fallback when the user's browser
fails to render a bookmarked tweet (geo-block, soft rate-limit, etc.).
Uses X's public syndication endpoint, which doesn't require auth for
public tweets and computes a deterministic per-tweet token the same
way X's official embed widget does.
"""
import logging
import re
import shutil
import subprocess

import requests
from fastapi import APIRouter, Depends, HTTPException

from auth import current_user
from models import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/x", tags=["x"])


def _syndication_token(tweet_id: int) -> str:
    """Token format X's embed widget uses to sign syndication requests:

        token = ((id / 1e15) * Math.PI).toString(36).replace(/(0+|\\.)/g, "")

    JS Number.prototype.toString(36) emits the *shortest* base-36 string
    that round-trips back to the same float64 (per ECMA-262 / Steele-White
    / Grisu shortest-output). A naive Python port that emits a fixed
    20-digit fractional expansion produces ~10 extra trailing characters
    AND can disagree with JS on the last shared digit (rounding-up).
    The syndication endpoint rejects the resulting token => HTTP 404.

    To stay byte-identical with the JS reference, we shell out to node
    when it's available. node is already a dependency for the YouTube
    flow (yt-dlp's JS runtime), so the runtime cost is just startup.
    """
    node_path = shutil.which("node") or shutil.which("deno")
    if not node_path:
        raise HTTPException(
            status_code=500,
            detail="node (or deno) not found on PATH; required to compute syndication token",
        )
    if "node" in node_path:
        js = (
            f"process.stdout.write("
            f"((Number({tweet_id}n)/1e15)*Math.PI).toString(36).replace(/(0+|\\.)/g, '')"
            f")"
        )
        cmd = [node_path, "-e", js]
    else:  # deno
        js = (
            f"Deno.stdout.writeSync(new TextEncoder().encode("
            f"((Number({tweet_id}n)/1e15)*Math.PI).toString(36).replace(/(0+|\\.)/g, '')"
            f"))"
        )
        cmd = [node_path, "eval", js]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except (subprocess.SubprocessError, OSError) as e:
        raise HTTPException(status_code=500, detail=f"token compute failed: {e}")
    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"token compute exited {result.returncode}: {result.stderr.strip()}",
        )
    token = result.stdout.strip()
    if not token:
        raise HTTPException(status_code=500, detail="token compute returned empty")
    return token


@router.get("/tweet")
def fetch_tweet(url: str, user: User = Depends(current_user)):
    """Fetch a public tweet via X's syndication endpoint and normalize."""
    m = re.search(r"/status/(\d+)", url)
    if not m:
        raise HTTPException(status_code=400, detail="URL must contain /status/<id>")
    tweet_id = int(m.group(1))
    token = _syndication_token(tweet_id)

    syndication_url = (
        f"https://cdn.syndication.twimg.com/tweet-result"
        f"?id={tweet_id}&token={token}&lang=en"
    )
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json",
    }
    try:
        r = requests.get(syndication_url, headers=headers, timeout=15)
    except requests.RequestException as e:
        logger.warning("syndication request failed: %s", e)
        raise HTTPException(status_code=502, detail=f"upstream error: {e}")

    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="tweet not found via syndication (may be private/deleted)")
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"syndication returned HTTP {r.status_code}",
        )

    try:
        data = r.json()
    except ValueError as e:
        raise HTTPException(status_code=502, detail=f"non-JSON response: {e}")

    if not data or not data.get("text"):
        raise HTTPException(status_code=404, detail="tweet has no text in syndication response")

    user_obj = data.get("user") or {}
    image_urls = []
    has_video = False
    for media in data.get("mediaDetails") or []:
        if media.get("type") == "photo":
            mu = media.get("media_url_https")
            if mu:
                image_urls.append(mu)
        elif media.get("type") in ("video", "animated_gif"):
            has_video = True

    return {
        "id": str(tweet_id),
        "permalink": url,
        "author_name": user_obj.get("name") or user_obj.get("screen_name") or "",
        "author_handle": user_obj.get("screen_name") or "",
        "text": data.get("text") or "",
        "timestamp": data.get("created_at") or "",
        "has_video": has_video,
        "image_urls": image_urls,
        "source": "syndication",
    }
