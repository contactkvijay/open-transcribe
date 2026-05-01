"""Server-side X tweet fetcher.

Used by the bookmarks extension as a fallback when the user's browser
fails to render a bookmarked tweet (geo-block, soft rate-limit, etc.).
Uses X's public syndication endpoint, which doesn't require auth for
public tweets and computes a deterministic per-tweet token the same
way X's official embed widget does.
"""
import logging
import math
import re

import requests
from fastapi import APIRouter, Depends, HTTPException

from auth import current_user
from models import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/x", tags=["x"])


_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _to_base36(value: float) -> str:
    """Match JS Number.prototype.toString(36) for non-negative floats."""
    if value == 0:
        return "0"
    int_part = int(value)
    frac_part = value - int_part

    int_str = ""
    if int_part == 0:
        int_str = "0"
    else:
        n = int_part
        while n > 0:
            int_str = _DIGITS[n % 36] + int_str
            n //= 36

    if frac_part == 0:
        return int_str

    frac_str = "."
    for _ in range(20):
        if frac_part == 0:
            break
        frac_part *= 36
        d = int(frac_part)
        frac_str += _DIGITS[d]
        frac_part -= d

    return int_str + frac_str


def _syndication_token(tweet_id: int) -> str:
    """JS reference: ((id / 1e15) * Math.PI).toString(36).replace(/(0+|\\.)/g, "")"""
    val = (tweet_id / 1e15) * math.pi
    s = _to_base36(val)
    return re.sub(r"(0+|\.)", "", s)


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
