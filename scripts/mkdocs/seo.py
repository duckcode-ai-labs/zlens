"""MkDocs hook: keep internal and archived pages out of search engines.

Design records (RFCs, specs, performance plans), maintainer notes and the
archived pages stay published at their URLs, so links to them keep working.
They are not user docs, so search engines should not list them.

A page is internal when its path matches a pattern in `extra.internal_pages`
(mkdocs.yml; shell-style, `*` also matches `/`), or when its front matter
sets `robots: noindex` itself. An internal page:

- carries <meta name="robots" content="noindex"> (scripts/mkdocs/overrides/main.html);
- is left out of the docs' own search (Material reads `search: exclude: true`);
- is left out of sitemap.xml (scripts/mkdocs/overrides/sitemap.xml).

The raw HTML prototypes (docs/prototypes/*.html) are copied as they are, so
each carries its own noindex tag.

Do not block these paths in docs/robots.txt: a crawler that may not fetch a
page never sees its noindex tag, and a URL it already knows stays listed.
"""

from __future__ import annotations

from fnmatch import fnmatchcase

NOINDEX = "noindex"


def is_noindex(meta: dict) -> bool:
    return NOINDEX in str(meta.get("robots") or "").lower()


def on_page_markdown(markdown, page, config, **kwargs):
    patterns = config.extra.get("internal_pages") or []
    src = page.file.src_uri
    if any(fnmatchcase(src, pattern) for pattern in patterns):
        page.meta.setdefault("robots", NOINDEX)
    if is_noindex(page.meta):
        search = page.meta.get("search")
        page.meta["search"] = {**(search if isinstance(search, dict) else {}), "exclude": True}
    return markdown
