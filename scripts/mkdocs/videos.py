"""MkDocs hook: link ZLens video tutorials on YouTube.

A page shows one video with a marker on a line of its own:

    {{ video("qs1-install") }}

and the Video tutorials page lists every playlist with:

    {{ videos() }}

Videos are links, not embedded players, so the docs make no requests to
YouTube. Each card shows a local thumbnail, the title and length, and an
optional note when the video differs from the current product.

    docs/media/videos.yml          playlists[] and videos{id: {...}}
    docs/media/videos/<id>.jpg     thumbnail (480x270)

An unknown id fails the build: `mkdocs build --strict` turns the warning into
an error, so a typo never ships as a broken card.
"""

from __future__ import annotations

import html
import logging
import os
import re
from typing import Any

import yaml
from mkdocs.utils import get_relative_url

log = logging.getLogger("mkdocs.hooks.videos")

VIDEO_DIR = "media/videos"
VIDEO_MARKER = re.compile(r'^[ \t]*\{\{\s*video\(\s*["\']([a-z0-9][a-z0-9-]*)["\']\s*\)\s*\}\}[ \t]*$', re.MULTILINE)
LIST_MARKER = re.compile(r"^[ \t]*\{\{\s*videos\(\s*\)\s*\}\}[ \t]*$", re.MULTILINE)
FENCE = re.compile(r"^[ \t]*(```|~~~)", re.MULTILINE)

_data_cache: dict[str, Any] | None = None


def _load(docs_dir: str) -> dict[str, Any]:
    global _data_cache
    if _data_cache is None:
        with open(os.path.join(docs_dir, "media", "videos.yml"), encoding="utf-8") as fh:
            _data_cache = yaml.safe_load(fh) or {}
    return _data_cache


def on_config(config, **kwargs):
    global _data_cache
    _data_cache = None  # re-read on every build (mkdocs serve reloads)
    return config


def _card(video_id: str, entry: dict[str, Any], page_url: str, docs_dir: str, doc_url: str | None = None) -> str:
    title = html.escape(str(entry.get("title", video_id)))
    href = f"https://youtu.be/{html.escape(str(entry['youtube']))}"
    length = html.escape(str(entry.get("length", "")))
    thumb = ""
    if os.path.isfile(os.path.join(docs_dir, VIDEO_DIR, f"{video_id}.jpg")):
        src = html.escape(get_relative_url(f"{VIDEO_DIR}/{video_id}.jpg", page_url))
        thumb = (
            f'<a class="zlens-video__thumb" href="{href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">'
            f'<img src="{src}" alt="" width="240" height="135" loading="lazy"></a>'
        )
    note = entry.get("note")
    note_html = f'<span class="zlens-video__note">{html.escape(str(note))}</span>' if note else ""
    docs_html = ""
    if doc_url is not None:
        docs_html = f'<a class="zlens-video__docs" href="{html.escape(get_relative_url(doc_url, page_url))}">Read the steps</a>'
    return (
        f'<div class="zlens-video">{thumb}<div class="zlens-video__body">'
        f'<span class="zlens-video__kicker">Video · {length}</span>'
        f'<a class="zlens-video__title" href="{href}" target="_blank" rel="noopener">{title}</a>'
        f"{note_html}{docs_html}</div></div>"
    )


def _list(data: dict[str, Any], page, docs_dir: str, files) -> str:
    videos = data.get("videos") or {}
    parts = []

    def doc_url(vid: str, v: dict[str, Any]) -> str | None:
        if not v.get("docs"):
            return None
        f = files.get_file_from_path(str(v["docs"]))
        if f is None:
            log.warning("docs/media/videos.yml: %s links to missing page '%s'", vid, v["docs"])
            return None
        return f.url

    for pl in data.get("playlists") or []:
        items = [(vid, v) for vid, v in videos.items() if v.get("playlist") == pl["key"]]
        if not items:
            continue
        link = f"https://www.youtube.com/playlist?list={html.escape(str(pl['youtube']))}"
        # A one-video section links the video itself; "Play all" adds nothing.
        play_all = f" [Play all on YouTube]({link}){{ target=_blank rel=noopener }}" if len(items) > 1 else ""
        parts.append(
            f"## {pl['title']}\n\n"
            f"{pl.get('summary', '')}{play_all}\n\n"
            f'<div class="zlens-video-list">'
            + "".join(_card(vid, v, page.url, docs_dir, doc_url(vid, v)) for vid, v in items)
            + "</div>"
        )
    return "\n\n".join(parts)


def _outside_fences(markdown: str):
    """Yield (start, end) spans of the page that are not inside fenced code."""
    inside, start = False, 0
    for m in FENCE.finditer(markdown):
        if not inside:
            yield (start, m.start())
            inside = True
        else:
            inside = False
            start = markdown.find("\n", m.end())
            start = len(markdown) if start == -1 else start
    if not inside:
        yield (start, len(markdown))


def on_page_markdown(markdown: str, page, config, files, **kwargs) -> str:
    if "video(" not in markdown and "videos(" not in markdown:
        return markdown
    docs_dir = config["docs_dir"]
    data = _load(docs_dir)
    videos = data.get("videos") or {}

    def one(m: re.Match) -> str:
        vid = m.group(1)
        if vid not in videos:
            log.warning("%s: unknown video id '%s' (add it to docs/media/videos.yml)", page.file.src_path, vid)
            return ""
        return "\n" + _card(vid, videos[vid], page.url, docs_dir) + "\n"

    out, last = [], 0
    for start, end in _outside_fences(markdown):
        segment = markdown[start:end]
        segment = VIDEO_MARKER.sub(one, segment)
        segment = LIST_MARKER.sub(lambda m: "\n" + _list(data, page, docs_dir, files) + "\n", segment)
        out.append(markdown[last:start])
        out.append(segment)
        last = end
    out.append(markdown[last:])
    return "".join(out)
