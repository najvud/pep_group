from __future__ import annotations

import asyncio
import hashlib
import html as html_lib
import json
import logging
import os
import re
import sys
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "channel.json"
DOCS_DIR = ROOT / "docs"
DATA_DIR = DOCS_DIR / "data"
POSTS_PATH = DATA_DIR / "posts.json"
COMMENTS_DIR = DATA_DIR / "comments"
POSTS_MEDIA_DIR = DATA_DIR / "media" / "posts"
MANIFEST_PATH = DOCS_DIR / "manifest.webmanifest"

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TelegramPagesMirror/1.0)",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}

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
        comments_posts_limit=int(env.get("COMMENTS_POSTS_LIMIT") or env.get("TG_COMMENTS_POSTS_LIMIT") or raw.get("comments_posts_limit") or 40),
        comments_max_age_days=int(env.get("COMMENTS_MAX_AGE_DAYS") or env.get("TG_COMMENTS_MAX_AGE_DAYS") or raw.get("comments_max_age_days") or 7),
    )

    if not config.channel_username or config.channel_username == "replace-with-channel-username":
        raise SystemExit("Set channel_username in config/channel.json before running the sync.")

    if not config.channel_title:
        config.channel_title = config.channel_username
    if not config.site_name:
        config.site_name = config.channel_title
    if not config.site_description:
        config.site_description = f"Static browser mirror for the public Telegram channel @{config.channel_username}."

    return config


def fetch_page(url: str) -> str:
    request = Request(url, headers=BASE_HEADERS)
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_binary(url: str) -> bytes:
    request = Request(
        url,
        headers={
            **BASE_HEADERS,
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
    )
    with urlopen(request, timeout=30) as response:
        return response.read()


def guess_media_extension(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"}:
        return suffix
    return ".jpg"


def mirror_post_photos(posts: list[dict[str, Any]]) -> bool:
    POSTS_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    active_relative_paths: set[str] = set()
    changes_detected = False

    for post in posts:
        mirrored_photos: list[str] = []

        for index, url in enumerate(post.get("photos") or []):
            if not url:
                continue

            if not re.match(r"^https?://", url):
                relative_url = url.lstrip("./")
                mirrored_photos.append(relative_url)
                active_relative_paths.add(relative_url)
                continue

            extension = guess_media_extension(url)
            digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
            filename = f"{post['id']}-{index + 1}-{digest}{extension}"
            local_path = POSTS_MEDIA_DIR / filename

            try:
                if not local_path.exists():
                    local_path.write_bytes(fetch_binary(url))
                    log.info("Downloaded post image %s", local_path.relative_to(ROOT))
                    changes_detected = True
            except Exception as error:  # pragma: no cover - network/runtime path
                log.warning("Failed to mirror image for post %s: %s", post["id"], error)
                mirrored_photos.append(url)
                continue

            relative_url = local_path.relative_to(DOCS_DIR).as_posix()
            mirrored_photos.append(relative_url)
            active_relative_paths.add(relative_url)

        if post.get("photos") != mirrored_photos:
            post["photos"] = mirrored_photos

    for path in POSTS_MEDIA_DIR.glob("*"):
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


def collect_posts(config: SiteConfig) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    before_id: int | None = None

    while len(posts) < config.messages_limit:
        url = config.channel_web_url if before_id is None else f"{config.channel_web_url}?before={before_id}"
        log.info("Fetching %s", url)
        page_html = fetch_page(url)
        page_posts = parse_posts(page_html, config)
        if not page_posts:
            break

        added = 0
        for post in page_posts:
            if post["id"] in seen_ids:
                continue
            posts.append(post)
            seen_ids.add(post["id"])
            added += 1
            if len(posts) >= config.messages_limit:
                break

        if added == 0:
            break

        before_id = min(post["id"] for post in page_posts)
        if len(page_posts) < 5:
            break
        time.sleep(1)

    posts.sort(key=lambda post: post["date"] or "", reverse=True)
    log.info("Collected %s posts", len(posts))
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


def build_posts_payload(config: SiteConfig, posts: list[dict[str, Any]], comments_enabled: bool) -> dict[str, Any]:
    return {
        "generated_at": None,
        "site": {
            "channel_username": config.channel_username,
            "channel_title": config.channel_title,
            "site_name": config.site_name,
            "site_description": config.site_description,
            "language": config.language,
            "accent_color": config.accent_color,
            "background_color": config.background_color,
            "avatar_path": config.avatar_path,
        },
        "source": {
            "channel_url": config.channel_web_url,
            "comments_enabled": comments_enabled,
        },
        "posts": posts,
    }


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


def main() -> int:
    config = load_config()
    write_manifest(config)

    posts = collect_posts(config)
    existing_payload = load_json(POSTS_PATH, {})
    if not posts and existing_payload.get("posts"):
        raise SystemExit("No posts were collected. Existing mirror data was left untouched.")

    comments_enabled, comment_results = asyncio.run(fetch_comments_for_posts(config, posts))

    for post in posts:
        if post["id"] in comment_results:
            post["comments_count"] = len(comment_results[post["id"]])

    changes_detected = False
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

    posts_payload = build_posts_payload(config, posts, comments_enabled)
    if write_json_if_changed(POSTS_PATH, posts_payload):
        changes_detected = True

    log.info("Done. Material changes detected: %s", "yes" if changes_detected else "no")
    return 0


if __name__ == "__main__":
    sys.exit(main())
