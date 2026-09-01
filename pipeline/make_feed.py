"""Publish data/changelog.json as feed.xml, an Atom feed of weekly changes.

One entry per refresh, not one per event: a reader wants "here is what moved
this week", and a feed that fires eleven times on a Monday morning gets muted.

Written by hand rather than with a library because the whole project's
constraint is that it keeps working for years with `requests` as its only
dependency. Atom is a small enough format to emit correctly from the standard
library, provided three things are right:

  * ids are stable and never reused, so an entry corrected by a same-day rerun
    updates in the reader instead of appearing twice;
  * every date is RFC 3339;
  * content is escaped, then declared as escaped HTML.
"""
import datetime
import json
import os
import sys
from xml.sax.saxutils import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

# The tag: URI scheme (RFC 4151) wants a date on which the domain was held by
# the author. Pinning it to the day the tracker started keeps every id stable
# no matter when the feed is regenerated.
TAG_BASE = "tag:{},2026-08-16:scfm-tracker".format(config.SITE_DOMAIN)

KIND_LABEL = {
    "baseline": "Tracking begins",
    "model_added": "New model",
    "rank_move": "Rank",
    "upkeep": "Upkeep",
    "license": "Licence",
    "milestone": "Milestone",
    "benchmark_paper": "New evaluation",
    "citing": "Citations",
    "first_comparison": "First comparison",
}


def safe_link(url):
    """A URL only becomes a link if it is http(s).

    Every url on an event today is an OpenAlex DOI, so this guards against
    nothing that currently exists -- but the feed is the one output rendered
    inside someone else's reader, and a `javascript:` href reaching that far
    is not a risk worth carrying for a two-line check.
    """
    url = (url or "").strip()
    return url if url[:7] == "http://" or url[:8] == "https://" else ""


def rfc3339(date_str):
    """A changelog date is a day; Atom wants an instant. 06:00 UTC is when the
    weekly Action is scheduled, so it is the closest honest reading."""
    return date_str + "T06:00:00Z"


def entry_title(entry):
    if entry.get("baseline"):
        return "Change tracking begins"
    n = len(entry.get("events", []))
    if not n:
        return "Week of {}: nothing changed".format(entry["date"])
    return "Week of {}: {} change{}".format(entry["date"], n, "" if n == 1 else "s")


def entry_content(entry):
    """The events as an escaped HTML list, per Atom's type="html"."""
    items = []
    for ev in entry.get("events", []):
        label = KIND_LABEL.get(ev.get("type"), "Change")
        text = escape(ev.get("text", ""))
        href = safe_link(ev.get("url"))
        if href:
            text += ' <a href="{}">DOI</a>'.format(escape(href, {'"': "&quot;"}))
        items.append("<li><strong>{}</strong> — {}</li>".format(escape(label), text))
    if not items:
        items.append("<li>No tracked field changed this week.</li>")
    html = "<ul>{}</ul>".format("".join(items))
    return escape(html)


def build(changelog, updated):
    entries = list(reversed(changelog.get("entries", [])))[:config.FEED_ENTRIES]
    out = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        "  <title>Single-Cell Foundation Model Tracker — weekly changes</title>",
        "  <subtitle>What moved in the single-cell foundation model field this "
        "week: new models, rank changes, repositories going quiet, and new "
        "benchmarking papers.</subtitle>",
        "  <id>{}</id>".format(TAG_BASE),
        "  <updated>{}</updated>".format(updated),
        '  <link rel="alternate" type="text/html" href="{}"/>'.format(config.SITE_URL),
        '  <link rel="self" type="application/atom+xml" href="{}feed.xml"/>'.format(
            config.SITE_URL),
        "  <author><name>Ali Eastman Oku</name></author>",
    ]
    for entry in entries:
        out += [
            "  <entry>",
            "    <title>{}</title>".format(escape(entry_title(entry))),
            "    <id>{}/changelog/{}</id>".format(TAG_BASE, entry["date"]),
            "    <updated>{}</updated>".format(rfc3339(entry["date"])),
            '    <link rel="alternate" type="text/html" href="{}"/>'.format(
                config.SITE_URL),
            '    <content type="html">{}</content>'.format(entry_content(entry)),
            "  </entry>",
        ]
    out.append("</feed>")
    return "\n".join(out) + "\n"


def main():
    if not os.path.exists(config.CHANGELOG_FILE):
        print("no changelog yet -- run build_data.py first")
        return
    with open(config.CHANGELOG_FILE) as fh:
        changelog = json.load(fh)
    entries = changelog.get("entries", [])
    updated = rfc3339(entries[-1]["date"]) if entries else (
        datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"))
    with open(config.FEED_FILE, "w") as fh:
        fh.write(build(changelog, updated))
    print("feed.xml: {} of {} entries published".format(
        min(len(entries), config.FEED_ENTRIES), len(entries)))


if __name__ == "__main__":
    main()
