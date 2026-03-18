from __future__ import annotations

import calendar
import asyncio
import hashlib
import html as html_lib
import io
import json
import logging
import math
import os
import re
import sys
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "channel.json"
DOCS_DIR = ROOT / "docs"
DATA_DIR = DOCS_DIR / "data"
CHANNEL_KEY = (os.environ.get("TG_CHANNEL_KEY") or "").strip()
CHANNELS_DATA_DIR = DATA_DIR / "channels"
CHANNEL_DATA_DIR = CHANNELS_DATA_DIR / CHANNEL_KEY if CHANNEL_KEY else DATA_DIR
POSTS_PATH = CHANNEL_DATA_DIR / "posts.json"
COMMENTS_DIR = CHANNEL_DATA_DIR / "comments"
PAGES_DIR = CHANNEL_DATA_DIR / "pages"
POST_DETAILS_DIR = CHANNEL_DATA_DIR / "posts"
POSTS_MEDIA_DIR = CHANNEL_DATA_DIR / "media" / "posts"
POSTS_THUMBS_DIR = POSTS_MEDIA_DIR / "thumbs"
CHANNEL_MEDIA_DIR = CHANNEL_DATA_DIR / "media"
CHANNEL_AVATAR_PATH = CHANNEL_MEDIA_DIR / "channel-avatar.jpg"
POST_PAGES_DIR = DOCS_DIR / "channels" / CHANNEL_KEY / "posts" if CHANNEL_KEY else DOCS_DIR / "posts"
MANIFEST_PATH = DOCS_DIR / "manifest.webmanifest"
FEED_PAGE_SIZE = 16
IMAGE_VARIANT_VERSION = "v2"

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TelegramPagesMirror/1.0)",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}
FETCH_RETRY_DELAYS = (1.0, 2.5, 5.0)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("telegram-pages-mirror")


@dataclass
class SiteConfig:
    channel_username: str
    channel_title: str
    site_name: str
    site_description: str
    language: str
    accent_color: str
    background_color: str
    avatar_path: str
    messages_limit: int
    recent_posts_months: int
    comments_posts_limit: int
    comments_max_age_days: int

    @property
    def channel_web_url(self) -> str:
        return f"https://t.me/s/{self.channel_username}"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError:
        return default


def json_without_generated_at(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: json_without_generated_at(item)
            for key, item in value.items()
            if key != "generated_at"
        }
    if isinstance(value, list):
        return [json_without_generated_at(item) for item in value]
    return value


def write_json_if_changed(path: Path, payload: dict[str, Any]) -> bool:
    existing = load_json(path, {})
    comparable_existing = json_without_generated_at(existing)
    comparable_next = json_without_generated_at(payload)
    if comparable_existing == comparable_next:
        log.info("No material changes in %s", path.relative_to(ROOT))
        return False

    payload = deepcopy(payload)
    payload["generated_at"] = datetime.now(timezone.utc).isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
    log.info("Updated %s", path.relative_to(ROOT))
    return True


def write_text_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text("utf-8") == content:
        log.info("No material changes in %s", path.relative_to(ROOT))
        return False
    path.write_text(content, "utf-8")
    log.info("Updated %s", path.relative_to(ROOT))
    return True


def load_config() -> SiteConfig:
    raw = load_json(CONFIG_PATH, {})
    env = os.environ

    config = SiteConfig(
        channel_username=(env.get("TELEGRAM_CHANNEL") or env.get("TG_CHANNEL_USERNAME") or raw.get("channel_username") or "").strip(),
        channel_title=(env.get("TG_CHANNEL_TITLE") or raw.get("channel_title") or "").strip(),
        site_name=(env.get("TG_SITE_NAME") or raw.get("site_name") or "").strip(),
        site_description=(env.get("TG_SITE_DESCRIPTION") or raw.get("site_description") or "").strip(),
        language=(env.get("TG_LANGUAGE") or raw.get("language") or "ru").strip(),
        accent_color=(env.get("TG_ACCENT_COLOR") or raw.get("accent_color") or "#0f766e").strip(),
        background_color=(env.get("TG_BACKGROUND_COLOR") or raw.get("background_color") or "#f7f3ea").strip(),
        avatar_path=(env.get("TG_AVATAR_PATH") or raw.get("avatar_path") or "").strip(),
        messages_limit=int(env.get("MESSAGES_LIMIT") or env.get("TG_MESSAGES_LIMIT") or raw.get("messages_limit") or 200),
        recent_posts_months=int(env.get("RECENT_POSTS_MONTHS") or env.get("TG_RECENT_POSTS_MONTHS") or raw.get("recent_posts_months") or 3),
        comments_posts_limit=int(env.get("COMMENTS_POSTS_LIMIT") or env.get("TG_COMMENTS_POSTS_LIMIT") or raw.get("comments_posts_limit") or 40),
        comments_max_age_days=int(env.get("COMMENTS_MAX_AGE_DAYS") or env.get("TG_COMMENTS_MAX_AGE_DAYS") or raw.get("comments_max_age_days") or 7),
    )

    if not config.channel_username or config.channel_username == "replace-with-channel-username":
        raise SystemExit("Set TG_CHANNEL_USERNAME or channel_username in config/channel.json before running the sync.")

    if not config.channel_title:
        config.channel_title = config.channel_username
    if not config.site_name:
        config.site_name = config.channel_title
    if not config.site_description:
        config.site_description = f"Static browser mirror for the public Telegram channel @{config.channel_username}."

    return config


def fetch_url(url: str, *, binary: bool = False) -> str | bytes:
    headers = BASE_HEADERS if not binary else {
        **BASE_HEADERS,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    }

    last_error: Exception | None = None
    for attempt, delay in enumerate((0.0, *FETCH_RETRY_DELAYS), start=1):
        if delay:
            time.sleep(delay)

        try:
            request = Request(url, headers=headers)
            with urlopen(request, timeout=30) as response:
                payload = response.read()
                return payload if binary else payload.decode("utf-8", errors="replace")
        except Exception as error:  # pragma: no cover - network/runtime path
            last_error = error
            log.warning("Fetch attempt %s failed for %s: %s", attempt, url, error)

    if last_error:
        raise last_error

    raise RuntimeError(f"Unable to fetch {url}")


def fetch_page(url: str) -> str:
    return str(fetch_url(url, binary=False))


def fetch_binary(url: str) -> bytes:
    return bytes(fetch_url(url, binary=True))


def build_telegram_avatar_url(channel_username: str) -> str:
    return f"https://t.me/i/userpic/320/{channel_username}.jpg"


def resolve_avatar_path(config: SiteConfig) -> str:
    if CHANNEL_AVATAR_PATH.exists():
        return CHANNEL_AVATAR_PATH.relative_to(DOCS_DIR).as_posix()

    if config.avatar_path and config.avatar_path != "assets/channel-avatar.jpg":
        return config.avatar_path

    return build_telegram_avatar_url(config.channel_username)


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def subtract_months(reference: datetime, months: int) -> datetime:
    month_index = reference.month - 1 - months
    year = reference.year + month_index // 12
    month = month_index % 12 + 1
    day = min(reference.day, calendar.monthrange(year, month)[1])
    return reference.replace(year=year, month=month, day=day)


def normalize_photo_entry(photo: Any) -> dict[str, str] | None:
    if not photo:
        return None
    if isinstance(photo, str):
        relative_url = photo.lstrip("./")
        return {
            "thumb_url": relative_url,
            "full_url": relative_url,
        }
    if isinstance(photo, dict):
        thumb_url = (photo.get("thumb_url") or photo.get("thumb") or photo.get("url") or "").lstrip("./")
        full_url = (photo.get("full_url") or photo.get("full") or photo.get("url") or thumb_url).lstrip("./")
        if not thumb_url and full_url:
            thumb_url = full_url
        if thumb_url and full_url:
            return {
                "thumb_url": thumb_url,
                "full_url": full_url,
            }
    return None


def optimize_image_variants(raw_bytes: bytes, full_path: Path, thumb_path: Path) -> bool:
    changes_detected = False
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(raw_bytes)) as image:
            image = ImageOps.exif_transpose(image)
            image.load()

            if image.mode not in ("RGB", "L"):
                background = Image.new("RGB", image.size, "white")
                alpha = image.getchannel("A") if "A" in image.getbands() else None
                background.paste(image.convert("RGBA"), mask=alpha)
                image = background
            elif image.mode == "L":
                image = image.convert("RGB")

            full_image = image.copy()
            full_image.thumbnail((1800, 1800))
            if not full_path.exists():
                full_image.save(full_path, format="JPEG", quality=86, optimize=True, progressive=True)
                changes_detected = True

            thumb_image = image.copy()
            thumb_image.thumbnail((960, 960))
            if not thumb_path.exists():
                thumb_image.save(thumb_path, format="JPEG", quality=78, optimize=True, progressive=True)
                changes_detected = True
    except Exception as error:  # pragma: no cover - runtime/image libs path
        log.warning("Image optimization fallback used: %s", error)
        if not full_path.exists():
            full_path.write_bytes(raw_bytes)
            changes_detected = True
        if not thumb_path.exists():
            thumb_path.write_bytes(raw_bytes)
            changes_detected = True

    return changes_detected


def optimize_single_image(raw_bytes: bytes, output_path: Path, max_size: tuple[int, int], quality: int = 86) -> bool:
    changed_detected = False
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(raw_bytes)) as image:
            image = ImageOps.exif_transpose(image)
            image.load()

            if image.mode not in ("RGB", "L"):
                background = Image.new("RGB", image.size, "white")
                alpha = image.getchannel("A") if "A" in image.getbands() else None
                background.paste(image.convert("RGBA"), mask=alpha)
                image = background
            elif image.mode == "L":
                image = image.convert("RGB")

            prepared = image.copy()
            prepared.thumbnail(max_size)

            buffer = io.BytesIO()
            prepared.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
            next_bytes = buffer.getvalue()
    except Exception as error:  # pragma: no cover - runtime/image libs path
        log.warning("Single image optimization fallback used: %s", error)
        next_bytes = raw_bytes

    if not output_path.exists() or output_path.read_bytes() != next_bytes:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(next_bytes)
        changed_detected = True

    return changed_detected


def parse_channel_avatar_url(html_text: str, channel_web_url: str) -> str | None:
    patterns = [
        r'tgme_page_photo_image[^>]+style="[^"]*url\([\'"]?([^\'")]+)',
        r'tgme_channel_info_header_photo[^>]+style="[^"]*url\([\'"]?([^\'")]+)',
        r'tgme_page_photo_image[^>]+src="([^"]+)"',
        r'tgme_channel_info_header_photo[^>]+src="([^"]+)"',
        r'<meta\s+property="og:image"\s+content="([^"]+)"',
        r'<link\s+rel="image_src"\s+href="([^"]+)"',
    ]

    for pattern in patterns:
        match = re.search(pattern, html_text, re.IGNORECASE)
        if match:
            return urljoin(channel_web_url, html_lib.unescape(match.group(1)))

    return None


def mirror_channel_avatar(config: SiteConfig, html_text: str) -> bool:
    avatar_url = parse_channel_avatar_url(html_text, config.channel_web_url)
    if not avatar_url:
        return False

    try:
        raw_bytes = fetch_binary(avatar_url)
    except Exception as error:  # pragma: no cover - network/runtime path
        log.warning("Failed to fetch channel avatar for %s: %s", config.channel_username, error)
        return False

    changed = optimize_single_image(raw_bytes, CHANNEL_AVATAR_PATH, (512, 512), quality=90)
    relative_avatar_path = CHANNEL_AVATAR_PATH.relative_to(DOCS_DIR).as_posix()
    if config.avatar_path != relative_avatar_path:
        config.avatar_path = relative_avatar_path
        changed = True

    return changed


def mirror_post_photos(posts: list[dict[str, Any]]) -> bool:
    POSTS_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    POSTS_THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    active_relative_paths: set[str] = set()
    changes_detected = False

    for post in posts:
        mirrored_photos: list[dict[str, str]] = []

        for index, raw_photo in enumerate(post.get("photos") or []):
            photo = normalize_photo_entry(raw_photo)
            if not photo:
                continue

            full_source = photo["full_url"]
            if not re.match(r"^https?://", full_source):
                active_relative_paths.add(full_source)
                active_relative_paths.add(photo["thumb_url"])
                mirrored_photos.append(photo)
                continue

            digest = hashlib.sha256(full_source.encode("utf-8")).hexdigest()[:12]
            filename = f"{post['id']}-{index + 1}-{digest}-{IMAGE_VARIANT_VERSION}.jpg"
            full_path = POSTS_MEDIA_DIR / filename
            thumb_path = POSTS_THUMBS_DIR / filename

            try:
                if not full_path.exists() or not thumb_path.exists():
                    raw_bytes = fetch_binary(full_source)
                    if optimize_image_variants(raw_bytes, full_path, thumb_path):
                        log.info("Prepared image variants for post %s", post["id"])
                        changes_detected = True
            except Exception as error:  # pragma: no cover - network/runtime path
                log.warning("Failed to mirror image for post %s: %s", post["id"], error)
                mirrored_photos.append(photo)
                continue

            full_relative_url = full_path.relative_to(DOCS_DIR).as_posix()
            thumb_relative_url = thumb_path.relative_to(DOCS_DIR).as_posix()
            mirrored_photos.append(
                {
                    "thumb_url": thumb_relative_url,
                    "full_url": full_relative_url,
                }
            )
            active_relative_paths.add(full_relative_url)
            active_relative_paths.add(thumb_relative_url)

        if post.get("photos") != mirrored_photos:
            post["photos"] = mirrored_photos

    for base_dir in (POSTS_MEDIA_DIR, POSTS_THUMBS_DIR):
        for path in base_dir.glob("*"):
            if not path.is_file():
                continue

            relative_url = path.relative_to(DOCS_DIR).as_posix()
            if relative_url in active_relative_paths:
                continue

            path.unlink()
            log.info("Deleted stale mirrored image %s", path.relative_to(ROOT))
            changes_detected = True

    return changes_detected


def parse_count(raw: str | None) -> int:
    if not raw:
        return 0

    token = re.sub(r"\s+", "", html_lib.unescape(raw)).upper()
    token = token.replace(",", ".")

    try:
        if token.endswith("K"):
            return int(float(token[:-1]) * 1000)
        if token.endswith("M"):
            return int(float(token[:-1]) * 1_000_000)
        digits = re.sub(r"[^\d]", "", token)
        return int(digits) if digits else 0
    except ValueError:
        return 0


def build_text_fields(raw_html: str) -> tuple[str | None, str | None]:
    raw_html = raw_html or ""
    raw_with_breaks = re.sub(r"<br\s*/?>", "\n", raw_html)
    anchors: list[str] = []

    def anchor_replacer(match: re.Match[str]) -> str:
        href = html_lib.unescape(match.group(1)).strip()
        label = html_lib.unescape(re.sub(r"<[^>]+>", "", match.group(2))).strip() or href
        if not href.startswith(("http://", "https://")):
            return html_lib.escape(label)
        token = f"__ANCHOR_{len(anchors)}__"
        anchors.append(
            f'<a href="{html_lib.escape(href)}" target="_blank" rel="noopener noreferrer">{html_lib.escape(label)}</a>'
        )
        return token

    html_markup = re.sub(
        r"<a[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>",
        anchor_replacer,
        raw_with_breaks,
        flags=re.DOTALL,
    )
    html_markup = re.sub(r"<[^>]+>", "", html_markup)
    html_markup = html_lib.unescape(html_markup)
    html_markup = re.sub(
        r"(https?://[^\s<]+)",
        r'<a href="\1" target="_blank" rel="noopener noreferrer">\1</a>',
        html_markup,
    )
    for index, anchor in enumerate(anchors):
        html_markup = html_markup.replace(f"__ANCHOR_{index}__", anchor)
    html_markup = html_markup.replace("\n", "<br>").strip() or None

    plain = re.sub(
        r"<a[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>",
        lambda match: html_lib.unescape(re.sub(r"<[^>]+>", "", match.group(2))).strip() or html_lib.unescape(match.group(1)),
        raw_with_breaks,
        flags=re.DOTALL,
    )
    plain = re.sub(r"<[^>]+>", "", plain)
    plain = html_lib.unescape(plain).strip() or None

    return plain, html_markup


def parse_posts(html_text: str, config: SiteConfig) -> list[dict[str, Any]]:
    blocks = re.split(r'(?=<div class="tgme_widget_message_wrap)', html_text)
    posts: list[dict[str, Any]] = []

    for block in blocks:
        id_match = re.search(r'tgme_widget_message_date[^>]*href="[^"]+/(\d+)"', block)
        if not id_match:
            continue

        post_id = int(id_match.group(1))
        date_match = re.search(r'<time[^>]+datetime="([^"]+)"', block)
        views_match = re.search(r'tgme_widget_message_views[^>]*>([^<]+)<', block)
        comments_count_match = re.search(r'tgme_widget_message_replies_count[^>]*>([^<]*)<', block)
        comments_link_match = re.search(r'tgme_widget_message_replies[^>]*href="([^"]+)"', block)
        text_match = re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>', block, re.DOTALL)
        video_match = re.search(r'<video[^>]+src="([^"]+)"', block)
        if not video_match:
            video_match = re.search(r'<source[^>]+src="([^"]+)"', block)

        photos = [
            urljoin("https://t.me", html_lib.unescape(url))
            for url in re.findall(r"tgme_widget_message_photo_wrap[^>]+url\('([^']+)'\)", block)
        ]
        if not photos:
            link_preview_match = re.search(r"link_preview_image[^>]+url\('([^']+)'\)", block)
            if link_preview_match:
                photos = [urljoin("https://t.me", html_lib.unescape(link_preview_match.group(1)))]
        video_url = urljoin("https://t.me", html_lib.unescape(video_match.group(1))) if video_match else None
        raw_text = text_match.group(1) if text_match else ""
        text, text_html = build_text_fields(raw_text)

        if not text and not photos and not video_url:
            continue

        comments_url = None
        if comments_link_match:
            comments_url = urljoin("https://t.me", html_lib.unescape(comments_link_match.group(1)))

        posts.append(
            {
                "id": post_id,
                "date": date_match.group(1) if date_match else None,
                "text": text,
                "text_html": text_html,
                "views": parse_count(views_match.group(1) if views_match else None),
                "comments_count": parse_count(comments_count_match.group(1) if comments_count_match else None),
                "comments_url": comments_url,
                "photos": photos,
                "video_url": video_url,
                "tg_url": f"https://t.me/{config.channel_username}/{post_id}",
            }
        )

    return posts


def collect_posts(config: SiteConfig, initial_page_html: str | None = None) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    before_id: int | None = None
    now = datetime.now(timezone.utc)
    cutoff = subtract_months(now, config.recent_posts_months)
    first_iteration = True

    while len(posts) < config.messages_limit:
        url = config.channel_web_url if before_id is None else f"{config.channel_web_url}?before={before_id}"
        if first_iteration and initial_page_html is not None:
            page_html = initial_page_html
            log.info("Using prefetched channel page %s", url)
        else:
            log.info("Fetching %s", url)
            try:
                page_html = fetch_page(url)
            except Exception as error:  # pragma: no cover - network/runtime path
                log.warning("Failed to fetch paginated channel page %s: %s", url, error)
                break
        page_posts = parse_posts(page_html, config)
        if not page_posts:
            break

        added = 0
        page_reached_cutoff = False
        for post in page_posts:
            post_date = parse_iso_datetime(post.get("date"))
            if post_date and post_date < cutoff:
                page_reached_cutoff = True
                continue
            if post["id"] in seen_ids:
                continue
            posts.append(post)
            seen_ids.add(post["id"])
            added += 1
            if len(posts) >= config.messages_limit:
                break

        if added == 0 and page_reached_cutoff:
            break

        if added == 0:
            break

        before_id = min(post["id"] for post in page_posts)
        oldest_page_date = min(
            (parse_iso_datetime(post.get("date")) for post in page_posts if parse_iso_datetime(post.get("date"))),
            default=None,
        )
        if oldest_page_date and oldest_page_date < cutoff:
            break
        if len(page_posts) < 5:
            break
        first_iteration = False
        time.sleep(1)

    posts = [
        post
        for post in posts
        if (post_date := parse_iso_datetime(post.get("date"))) is None or post_date >= cutoff
    ]
    posts.sort(key=lambda post: post["date"] or "", reverse=True)
    log.info("Collected %s posts from the last %s months", len(posts), config.recent_posts_months)
    return posts[: config.messages_limit]


def select_posts_for_comment_refresh(posts: list[dict[str, Any]], config: SiteConfig) -> list[int]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=config.comments_max_age_days)
    selected: list[int] = []

    for index, post in enumerate(posts):
        post_date = None
        if post.get("date"):
            try:
                post_date = datetime.fromisoformat(post["date"])
            except ValueError:
                post_date = None

        if index < config.comments_posts_limit or (post_date and post_date >= cutoff):
            selected.append(post["id"])

    return selected


async def fetch_comments_for_posts(config: SiteConfig, posts: list[dict[str, Any]]) -> tuple[bool, dict[int, list[dict[str, Any]]]]:
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    session_string = os.environ.get("TELEGRAM_SESSION_STR")

    if not all((api_id, api_hash, session_string)):
        log.info("Telegram user session is not configured. Comment sync skipped.")
        return False, {}

    from telethon import TelegramClient
    from telethon.errors import ChannelPrivateError, MsgIdInvalidError, RPCError
    from telethon.sessions import StringSession
    from telethon.tl.functions.messages import GetDiscussionMessageRequest
    from telethon.utils import get_display_name

    selected_ids = select_posts_for_comment_refresh(posts, config)
    log.info("Refreshing comments for %s posts", len(selected_ids))
    results: dict[int, list[dict[str, Any]]] = {}

    async with TelegramClient(StringSession(session_string), int(api_id), api_hash) as client:
        if not await client.is_user_authorized():
            raise RuntimeError("TELEGRAM_SESSION_STR is not authorized.")

        channel = await client.get_entity(config.channel_username)

        for post_id in selected_ids:
            try:
                discussion = await client(GetDiscussionMessageRequest(peer=channel, msg_id=post_id))
                if not discussion.messages:
                    results[post_id] = []
                    continue

                root_message = discussion.messages[0]
                discussion_peer = await client.get_input_entity(root_message.peer_id)
                comments: list[dict[str, Any]] = []

                async for message in client.iter_messages(discussion_peer, reply_to=root_message.id, reverse=True):
                    text = (message.message or "").strip()
                    if not text and message.media:
                        text = "[media]"
                    if not text:
                        continue

                    author = message.post_author
                    if not author:
                        sender = await message.get_sender()
                        if sender:
                            author = get_display_name(sender) or None
                            if not author and getattr(sender, "username", None):
                                author = f"@{sender.username}"

                    comments.append(
                        {
                            "id": message.id,
                            "author": author or "Telegram user",
                            "text": text,
                            "date": message.date.astimezone(timezone.utc).isoformat() if message.date else None,
                        }
                    )

                results[post_id] = comments
                log.info("Fetched %s comments for post %s", len(comments), post_id)
            except (MsgIdInvalidError, ChannelPrivateError):
                results[post_id] = []
            except RPCError as error:
                log.warning("Telegram RPC error on post %s: %s", post_id, error)
                results[post_id] = []
            except Exception as error:  # pragma: no cover - network/runtime path
                log.warning("Comment sync failed on post %s: %s", post_id, error)
                results[post_id] = []

            await asyncio.sleep(0.3)

    return True, results


def write_manifest(config: SiteConfig) -> bool:
    manifest = {
        "name": config.site_name,
        "short_name": config.channel_title[:12] or config.site_name[:12],
        "description": config.site_description,
        "start_url": "./",
        "display": "standalone",
        "background_color": config.background_color,
        "theme_color": config.accent_color,
        "lang": config.language,
        "icons": [
            {
                "src": "assets/icon.svg",
                "sizes": "any",
                "type": "image/svg+xml",
                "purpose": "any maskable",
            },
            {
                "src": "assets/icon-192.png",
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "any maskable",
            },
            {
                "src": "assets/icon-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any maskable",
            }
        ],
    }
    return write_text_if_changed(MANIFEST_PATH, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def build_site_payload(config: SiteConfig) -> dict[str, Any]:
    return {
        "channel_username": config.channel_username,
        "channel_title": config.channel_title,
        "site_name": config.site_name,
        "site_description": config.site_description,
        "language": config.language,
        "accent_color": config.accent_color,
        "background_color": config.background_color,
        "avatar_path": resolve_avatar_path(config),
    }


def build_source_payload(config: SiteConfig, comments_enabled: bool) -> dict[str, Any]:
    return {
        "channel_key": CHANNEL_KEY or config.channel_username.lower(),
        "channel_url": config.channel_web_url,
        "comments_enabled": comments_enabled,
        "recent_posts_months": config.recent_posts_months,
    }


def build_feed_index_payload(config: SiteConfig, posts: list[dict[str, Any]], comments_enabled: bool) -> dict[str, Any]:
    total_pages = max(1, math.ceil(len(posts) / FEED_PAGE_SIZE))
    return {
        "generated_at": None,
        "site": build_site_payload(config),
        "source": build_source_payload(config, comments_enabled),
        "pagination": {
            "page": 1,
            "page_size": FEED_PAGE_SIZE,
            "total_posts": len(posts),
            "total_pages": total_pages,
        },
        "posts": posts[:FEED_PAGE_SIZE],
    }


def build_feed_page_payload(page: int, posts: list[dict[str, Any]], total_posts: int) -> dict[str, Any]:
    total_pages = max(1, math.ceil(total_posts / FEED_PAGE_SIZE))
    start = (page - 1) * FEED_PAGE_SIZE
    end = start + FEED_PAGE_SIZE
    return {
        "generated_at": None,
        "pagination": {
            "page": page,
            "page_size": FEED_PAGE_SIZE,
            "total_posts": total_posts,
            "total_pages": total_pages,
        },
        "posts": posts[start:end],
    }


def build_post_payload(config: SiteConfig, post: dict[str, Any], comments_enabled: bool) -> dict[str, Any]:
    return {
        "generated_at": None,
        "site": build_site_payload(config),
        "source": build_source_payload(config, comments_enabled),
        "post": post,
    }


def strip_tags(value: str | None) -> str:
    return re.sub(r"<[^>]+>", "", value or "").strip()


def collapse_whitespace(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()


def shorten_text(value: str | None, limit: int) -> str:
    collapsed = collapse_whitespace(value)
    if len(collapsed) <= limit:
        return collapsed
    clipped = collapsed[:limit].rsplit(" ", 1)[0].strip()
    return f"{clipped}…" if clipped else collapsed[:limit]


def render_post_page_media(post: dict[str, Any]) -> str:
    root_prefix = "../../../" if CHANNEL_KEY else "../../"
    photos = [normalize_photo_entry(photo) for photo in post.get("photos") or []]
    photos = [photo for photo in photos if photo]
    if not photos and not post.get("video_url"):
        return ""

    media_items: list[str] = []
    for index, photo in enumerate(photos):
        media_items.append(
            (
                '<a class="media-trigger" href="{root_prefix}{full_url}" target="_blank" rel="noopener">'
                '<img src="{root_prefix}{thumb_url}" '
                'srcset="{root_prefix}{thumb_url} 640w, {root_prefix}{full_url} 1600w" '
                'sizes="(max-width: 860px) calc(100vw - 44px), 980px" '
                'alt="Media {index}" loading="lazy" decoding="async"></a>'
            ).format(
                root_prefix=root_prefix,
                full_url=html_lib.escape(photo["full_url"]),
                thumb_url=html_lib.escape(photo["thumb_url"]),
                index=index + 1,
            )
        )

    if post.get("video_url"):
        media_items.append(
            f'<video src="{html_lib.escape(post["video_url"])}" preload="metadata" controls playsinline></video>'
        )

    gallery_class = "post-card__media post-card__media--gallery" if len(media_items) > 1 else "post-card__media"
    return f'<div class="{gallery_class}">{"".join(media_items)}</div>'


def render_post_page_html(config: SiteConfig, post: dict[str, Any], comments_enabled: bool) -> str:
    root_prefix = "../../../" if CHANNEL_KEY else "../../"
    feed_href = f"{root_prefix}?channel={CHANNEL_KEY}" if CHANNEL_KEY else root_prefix
    title = shorten_text(post.get("text") or f"Пост #{post['id']}", 72) or f"Пост #{post['id']}"
    description = shorten_text(strip_tags(post.get("text_html") or post.get("text") or ""), 180) or config.site_description
    first_photo = normalize_photo_entry((post.get("photos") or [None])[0])
    og_image = f"{root_prefix}{first_photo['full_url']}" if first_photo else f"{root_prefix}{config.avatar_path}"
    comments_link = f'{feed_href}#comments-{post["id"]}' if comments_enabled else feed_href
    comments_cta = ""
    if comments_enabled and (post.get("comments_count") or post.get("comments_url") or post.get("comments_available")):
        comments_cta = (
            f'<a class="button button--ghost" href="{comments_link}">'
            f'Комментарии ({post.get("comments_count") or 0})</a>'
        )

    return f"""<!DOCTYPE html>
<html lang="{html_lib.escape(config.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html_lib.escape(title)} | {html_lib.escape(config.channel_title)}</title>
  <meta name="description" content="{html_lib.escape(description)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{html_lib.escape(title)}">
  <meta property="og:description" content="{html_lib.escape(description)}">
  <meta property="og:image" content="{html_lib.escape(og_image)}">
  <meta property="article:published_time" content="{html_lib.escape(post.get("date") or "")}">
  <meta name="theme-color" content="{html_lib.escape(config.accent_color)}">
  <link rel="icon" href="{root_prefix}assets/icon.svg" type="image/svg+xml">
  <link rel="icon" href="{root_prefix}assets/icon-192.png" sizes="192x192" type="image/png">
  <link rel="apple-touch-icon" href="{root_prefix}assets/apple-touch-icon.png">
  <link rel="manifest" href="{root_prefix}manifest.webmanifest">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="{root_prefix}style.css">
  <script>
    (function() {{
      var theme = localStorage.getItem('theme');
      if (theme) document.documentElement.setAttribute('data-theme', theme);
    }})();
  </script>
</head>
<body>
  <div class="site-shell post-shell">
    <header class="post-header">
      <div>
        <p class="eyebrow">Отдельная страница поста</p>
        <h1 class="post-page-title">{html_lib.escape(title)}</h1>
      </div>
      <div class="post-header__actions">
        <a class="button button--ghost" href="{feed_href}">К ленте</a>
        <a class="button button--primary" href="{html_lib.escape(post["tg_url"])}" target="_blank" rel="noopener">В Telegram</a>
      </div>
    </header>

    <article class="post-card">
      {render_post_page_media(post)}
      <div class="post-card__body">
        <div class="post-card__text">{post.get("text_html") or html_lib.escape(post.get("text") or "").replace(chr(10), "<br>")}</div>
      </div>
      <div class="post-card__footer">
        <div class="post-card__stats">
          <span class="chip">{html_lib.escape(post.get("date") or "")}</span>
          <span class="chip">Просмотры: {post.get("views") or 0}</span>
        </div>
        <div class="post-card__links">
          {comments_cta}
          <a class="post-card__link" href="{html_lib.escape(post["tg_url"])}" target="_blank" rel="noopener">Открыть в Telegram</a>
        </div>
      </div>
    </article>
  </div>
</body>
</html>
"""


def cleanup_removed_page_files(total_pages: int) -> bool:
    changed = False
    for path in PAGES_DIR.glob("*.json"):
        try:
            page = int(path.stem)
        except ValueError:
            continue
        if 2 <= page <= total_pages:
            continue
        path.unlink()
        changed = True
        log.info("Deleted stale page file %s", path.relative_to(ROOT))
    return changed


def cleanup_removed_post_detail_files(active_post_ids: set[int]) -> bool:
    changed = False

    for path in POST_DETAILS_DIR.glob("*.json"):
        try:
            post_id = int(path.stem)
        except ValueError:
            continue
        if post_id in active_post_ids:
            continue
        path.unlink()
        changed = True
        log.info("Deleted stale post payload %s", path.relative_to(ROOT))

    for directory in (POST_PAGES_DIR.iterdir() if POST_PAGES_DIR.exists() else []):
        if not directory.is_dir():
            continue
        try:
            post_id = int(directory.name)
        except ValueError:
            continue
        if post_id in active_post_ids:
            continue
        for child in directory.glob("*"):
            child.unlink()
        directory.rmdir()
        changed = True
        log.info("Deleted stale post page %s", directory.relative_to(ROOT))

    return changed


def cleanup_removed_comment_files(active_post_ids: set[int]) -> bool:
    changed = False
    for path in COMMENTS_DIR.glob("*.json"):
        try:
            post_id = int(path.stem)
        except ValueError:
            continue

        if post_id not in active_post_ids:
            path.unlink()
            changed = True
            log.info("Deleted stale comment file %s", path.name)
    return changed


def write_feed_files(config: SiteConfig, posts: list[dict[str, Any]], comments_enabled: bool) -> bool:
    changed = False
    total_pages = max(1, math.ceil(len(posts) / FEED_PAGE_SIZE))
    if write_json_if_changed(POSTS_PATH, build_feed_index_payload(config, posts, comments_enabled)):
        changed = True

    PAGES_DIR.mkdir(parents=True, exist_ok=True)
    for page in range(2, total_pages + 1):
        payload = build_feed_page_payload(page, posts, len(posts))
        if write_json_if_changed(PAGES_DIR / f"{page}.json", payload):
            changed = True

    changed = cleanup_removed_page_files(total_pages) or changed
    return changed


def write_post_detail_files(config: SiteConfig, posts: list[dict[str, Any]], comments_enabled: bool) -> bool:
    changed = False
    POST_DETAILS_DIR.mkdir(parents=True, exist_ok=True)
    POST_PAGES_DIR.mkdir(parents=True, exist_ok=True)

    for post in posts:
        payload = build_post_payload(config, post, comments_enabled)
        if write_json_if_changed(POST_DETAILS_DIR / f"{post['id']}.json", payload):
            changed = True

        page_dir = POST_PAGES_DIR / str(post["id"])
        page_dir.mkdir(parents=True, exist_ok=True)
        page_html = render_post_page_html(config, post, comments_enabled)
        if write_text_if_changed(page_dir / "index.html", page_html):
            changed = True

    changed = cleanup_removed_post_detail_files({post["id"] for post in posts}) or changed
    return changed


def main() -> int:
    config = load_config()
    if not CHANNEL_KEY:
        write_manifest(config)

    existing_payload = load_json(POSTS_PATH, {})
    try:
        initial_page_html = fetch_page(config.channel_web_url)
    except Exception as error:  # pragma: no cover - network/runtime path
        if existing_payload.get("posts"):
            log.warning(
                "Failed to fetch initial page for @%s. Keeping existing mirror data: %s",
                config.channel_username,
                error,
            )
            return 0
        raise

    avatar_changed = mirror_channel_avatar(config, initial_page_html)
    posts = collect_posts(config, initial_page_html=initial_page_html)
    if not posts and existing_payload.get("posts"):
        log.warning("No posts were collected for @%s. Existing mirror data was left untouched.", config.channel_username)
        return 0

    comments_enabled, comment_results = asyncio.run(fetch_comments_for_posts(config, posts))

    for post in posts:
        if post["id"] in comment_results:
            post["comments_count"] = len(comment_results[post["id"]])

    changes_detected = avatar_changed
    active_ids = {post["id"] for post in posts}
    changes_detected = mirror_post_photos(posts) or changes_detected
    changes_detected = cleanup_removed_comment_files(active_ids) or changes_detected

    for post_id, comments in comment_results.items():
        payload = {
            "generated_at": None,
            "post_id": post_id,
            "comments": comments,
        }
        if write_json_if_changed(COMMENTS_DIR / f"{post_id}.json", payload):
            changes_detected = True

    changes_detected = write_feed_files(config, posts, comments_enabled) or changes_detected
    changes_detected = cleanup_removed_post_detail_files(set()) or changes_detected

    log.info("Done. Material changes detected: %s", "yes" if changes_detected else "no")
    return 0


if __name__ == "__main__":
    sys.exit(main())
