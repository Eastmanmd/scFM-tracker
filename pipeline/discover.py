"""Scan bioRxiv and arXiv for models that ought to be on the tracker.

The registry is curated on purpose: a model earns a row by being a single-cell
RNA-seq foundation model, and no keyword match can settle that. So this step
never edits registry.json. It writes a queue -- pipeline/discovery_queue.json --
and a human promotes or dismisses each row.

Two sources, two shapes. arXiv has a real search API, so each term is one
query. bioRxiv has none: its details endpoint pages a date interval thirty
records at a time and the filtering happens here, which is why the scan is
incremental. cache/discovery.json remembers the date already paged so a weekly
run covers a week rather than re-reading a month.

Dedupe is deliberately lopsided. A DOI already in the registry means the paper
is tracked, and the candidate is dropped. A registry *name* appearing in a
title only annotates the row, because the distinctive-name assumption breaks on
exactly the models whose names are ordinary words -- STATE and UCE -- and
dropping "cell state transitions after perturbation" to save a reviewer one
glance is the wrong trade in a tool whose entire job is not missing things.
"""
import datetime
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

# Bumped when the candidate record changes shape, so a queue written by an
# older pipeline is re-annotated rather than served with missing fields.
QUEUE_SCHEMA = 1

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"

# Registry names that are ordinary English words. Matching these against a
# title says nothing, so they never raise the "already tracked" annotation.
AMBIGUOUS_NAMES = set(["state", "uce", "cell", "cells", "universal"])


def normalize(text):
    """Lowercase, fold dashes to spaces, collapse whitespace.

    Both the search terms and the text being searched go through this, so
    "single-cell", "single cell" and "single–cell" are one string.
    """
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r"[‐-―\-_/]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalized_terms():
    """The configured terms, normalized and deduped, longest first."""
    seen = []
    for term in config.DISCOVERY_TERMS:
        norm = normalize(term)
        if norm and norm not in seen:
            seen.append(norm)
    return sorted(seen, key=len, reverse=True)


def matched_terms(terms, *texts):
    """Which terms appear in any of the given texts."""
    haystack = " ".join(normalize(t) for t in texts if t)
    return [t for t in terms if t in haystack]


def clean_doi(doi):
    """Bare lowercase DOI, however it was written."""
    if not doi:
        return ""
    doi = doi.strip().lower()
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi)
    doi = re.sub(r"^doi:\s*", "", doi)
    return doi.strip()


NAME_INTRO = re.compile(
    r"\b(?:we\s+(?:present|introduce|propose)|"
    r"(?:here|we)\s+(?:describe|report))\s+"
    r"([A-Za-z][A-Za-z0-9\.\-]{1,24})\b", re.IGNORECASE)
NAME_COLON = re.compile(
    "^\\s*([A-Za-z][A-Za-z0-9\\.\\-]{1,24})\\s*[:\u2014-]\\s+\\S")


def looks_like_a_name(token):
    """Reject ordinary words. A model name carries odd case or a digit."""
    if not token or re.match(r"^[a-z]+$", token):
        return False
    if any(c.isdigit() for c in token):
        return True
    # "Towards", "Single" -- capitalised, but just the first word of a title.
    return not re.match(r"^[A-Z][a-z]+$", token)


def guess_name(title, abstract=None):
    """The model name a paper announces, if it announces one.

    Papers name models in a handful of shapes -- "scKITE: a ...", "We present
    scKITE", "scKITE, a foundation model". The title is checked first, then
    the abstract, because plenty of papers title themselves "Towards a
    knowledge-enhanced single-cell foundation model" and name the thing only
    in the first sentence of the abstract. It is a convenience for the
    reviewer, not a decision, so a miss costs nothing.
    """
    for text, patterns in ((title, (NAME_COLON, NAME_INTRO)),
                           (abstract, (NAME_INTRO,))):
        if not text:
            continue
        for pattern in patterns:
            found = pattern.search(text.strip())
            if found and looks_like_a_name(found.group(1)):
                return found.group(1)
    return None


def tracked_facts():
    """Known DOIs and known model names, read from the registry and its cache.

    resolve_ids.py is what turns the hand-written registry titles into DOIs, so
    its cache is where the DOIs live. A missing cache is not fatal -- discovery
    still runs, it just cannot drop already-tracked papers by DOI.
    """
    dois = set()
    names = {}

    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)
    for model in registry["models"]:
        mid = model["id"]
        tokens = set()
        for chunk in re.split(r"[/()]", model.get("name") or ""):
            token = normalize(chunk).replace(" ", "")
            if len(token) >= 3 and token not in AMBIGUOUS_NAMES:
                tokens.add(token)
        mid_token = normalize(mid).replace(" ", "")
        if len(mid_token) >= 3 and mid_token not in AMBIGUOUS_NAMES:
            tokens.add(mid_token)
        if tokens:
            names[mid] = tokens

    if os.path.exists(config.RESOLVED_FILE):
        with open(config.RESOLVED_FILE) as fh:
            resolved = json.load(fh)
        for entry in resolved.values():
            for paper in entry.get("papers") or []:
                doi = clean_doi(paper.get("doi"))
                if doi:
                    dois.add(doi)
    else:
        print("  note: {} absent -- run resolve_ids.py for DOI dedupe".format(
            os.path.basename(config.RESOLVED_FILE)))

    return dois, names


def tracked_matches(title, names):
    """Registry ids whose name shows up as a word in this title."""
    flat = normalize(title).replace(" ", "")
    hits = []
    for mid, tokens in names.items():
        if any(token in flat for token in tokens):
            hits.append(mid)
    return sorted(hits)


# ---------------------------------------------------------------------------
# bioRxiv
# ---------------------------------------------------------------------------

def biorxiv_page(start, end, cursor, attempts=4):
    """One page of the details endpoint, or (None, status) on failure.

    A non-200 is never read as "no more results". Treating a 429 as the end of
    the interval would silently truncate the scan and the week would look
    quiet, which is the failure this pipeline is built to avoid.
    """
    url = "{}/{}/{}/{}/json".format(config.BIORXIV_API, start, end, cursor)
    delay = 5.0
    for attempt in range(attempts):
        try:
            resp = requests.get(url, timeout=60)
        except requests.RequestException as exc:
            if attempt < attempts - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return None, "network: {}".format(exc)
        if resp.status_code == 200:
            try:
                return resp.json(), 200
            except ValueError:
                return None, "unparseable json"
        if attempt < attempts - 1 and resp.status_code in (429, 500, 502, 503):
            print("    http {} -- waiting {:.0f}s".format(resp.status_code, delay))
            time.sleep(delay)
            delay *= 2
            continue
        return None, "http {}".format(resp.status_code)
    return None, "exhausted"


def scan_chunk(start, end, terms, budget):
    """Page one date interval. Returns (hits, complete, pages_used)."""
    hits = {}
    cursor = 0
    pages = 0
    scanned = 0
    while pages < budget:
        payload, status = biorxiv_page(start, end, cursor)
        if payload is None:
            print("  {} .. {}  page {} failed ({})".format(
                start, end, cursor, status))
            return hits, False, pages
        collection = payload.get("collection") or []
        messages = payload.get("messages") or [{}]
        total = messages[0].get("total")
        pages += 1
        if not collection:
            break
        for rec in collection:
            scanned += 1
            terms_hit = matched_terms(terms, rec.get("title"), rec.get("abstract"))
            if not terms_hit:
                continue
            doi = clean_doi(rec.get("doi"))
            if not doi:
                continue
            abstract = (rec.get("abstract") or "").strip()
            hits[doi] = {
                "key": doi,
                "source": "biorxiv",
                "doi": doi,
                "url": "https://doi.org/{}".format(doi),
                "title": (rec.get("title") or "").strip(),
                "abstract": abstract[:config.DISCOVERY_ABSTRACT_CHARS],
                "date": rec.get("date"),
                "authors": (rec.get("authors") or "").split(";")[0].strip() or None,
                "category": rec.get("category"),
                "version": rec.get("version"),
                "matched_terms": terms_hit,
            }
        cursor += len(collection)
        if total is not None:
            try:
                if cursor >= int(total):
                    break
            except (TypeError, ValueError):
                pass
        time.sleep(config.BIORXIV_DELAY)
    else:
        # Budget gone mid-interval: this chunk is not covered, so the caller
        # must not advance the watermark past it.
        print("  {} .. {}  budget exhausted after {} pages".format(
            start, end, pages))
        return hits, False, pages

    print("  {} .. {}  {:>5} scanned, {} matched".format(
        start, end, scanned, len(hits)))
    return hits, True, pages


def scan_biorxiv(start, end, terms):
    """Scan the window a chunk at a time.

    Returns (hits, covered_through, complete). `covered_through` is the last
    date fully paged -- the watermark the next run resumes from. It advances
    per completed chunk rather than only on a clean full sweep, so a run that
    runs out of budget still moves the scan forward.
    """
    hits = {}
    covered_through = None
    budget = config.BIORXIV_PAGE_BUDGET
    chunk_start = start
    span = datetime.timedelta(days=config.BIORXIV_CHUNK_DAYS - 1)
    one_day = datetime.timedelta(days=1)

    print("bioRxiv  {} .. {}  (budget {} pages)".format(
        start.isoformat(), end.isoformat(), budget))
    while chunk_start <= end:
        chunk_end = min(chunk_start + span, end)
        chunk_hits, complete, used = scan_chunk(
            chunk_start.isoformat(), chunk_end.isoformat(), terms, budget)
        hits.update(chunk_hits)
        budget -= used
        if not complete:
            return hits, covered_through, False
        covered_through = chunk_end
        if budget <= 0 and chunk_end < end:
            print("  budget spent -- next run resumes at {}".format(
                (chunk_end + one_day).isoformat()))
            return hits, covered_through, False
        chunk_start = chunk_end + one_day

    return hits, covered_through, True


# ---------------------------------------------------------------------------
# arXiv
# ---------------------------------------------------------------------------

def arxiv_query(term, attempts=4):
    """Search arXiv for one term. Returns (entries, status)."""
    params = {
        "search_query": 'all:"{}"'.format(term),
        "start": 0,
        "max_results": config.ARXIV_MAX_RESULTS,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    delay = 5.0
    for attempt in range(attempts):
        try:
            resp = requests.get(config.ARXIV_API, params=params, timeout=60)
        except requests.RequestException as exc:
            if attempt < attempts - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return None, "network: {}".format(exc)
        if resp.status_code == 200:
            try:
                root = ET.fromstring(resp.text.encode("utf-8"))
            except ET.ParseError as exc:
                return None, "unparseable atom: {}".format(exc)
            return root.findall("{}entry".format(ATOM)), 200
        if attempt < attempts - 1 and resp.status_code in (429, 500, 502, 503):
            print("    http {} -- waiting {:.0f}s".format(resp.status_code, delay))
            time.sleep(delay)
            delay *= 2
            continue
        return None, "http {}".format(resp.status_code)
    return None, "exhausted"


def arxiv_text(entry, tag):
    node = entry.find("{}{}".format(ATOM, tag))
    if node is None or node.text is None:
        return ""
    return re.sub(r"\s+", " ", node.text).strip()


def scan_arxiv(since, terms):
    """One query per term, keeping entries submitted on or after `since`."""
    hits = {}
    failures = []
    print("arXiv    submitted on or after {}".format(since))
    for term in terms:
        entries, status = arxiv_query(term)
        time.sleep(config.ARXIV_DELAY)
        if entries is None:
            print("  {:<34} FAILED {}".format(term, status))
            failures.append(term)
            continue
        kept = 0
        for entry in entries:
            published = arxiv_text(entry, "published")[:10]
            if not published or published < since:
                continue
            raw_id = arxiv_text(entry, "id")
            arxiv_id = raw_id.rsplit("/", 1)[-1] if raw_id else ""
            if not arxiv_id:
                continue
            key = "arxiv:{}".format(re.sub(r"v\d+$", "", arxiv_id))
            title = arxiv_text(entry, "title")
            summary = arxiv_text(entry, "summary")
            terms_hit = matched_terms(terms, title, summary)
            if not terms_hit:
                continue
            doi_node = entry.find("{}doi".format(ARXIV_NS))
            primary = entry.find("{}primary_category".format(ARXIV_NS))
            authors = entry.findall("{}author".format(ATOM))
            first_author = None
            if authors:
                name = authors[0].find("{}name".format(ATOM))
                first_author = name.text.strip() if name is not None and name.text else None
            if key in hits:
                merged = sorted(set(hits[key]["matched_terms"]) | set(terms_hit))
                hits[key]["matched_terms"] = merged
                continue
            hits[key] = {
                "key": key,
                "source": "arxiv",
                "doi": clean_doi(doi_node.text) if doi_node is not None else None,
                "url": raw_id.replace("http://", "https://"),
                "title": title,
                "abstract": summary[:config.DISCOVERY_ABSTRACT_CHARS],
                "date": published,
                "authors": first_author,
                "category": primary.get("term") if primary is not None else None,
                "version": None,
                "matched_terms": terms_hit,
            }
            kept += 1
        print("  {:<34} {:>3} in window".format(term, kept))
    return hits, failures


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------

def load_queue():
    if not os.path.exists(config.DISCOVERY_QUEUE_FILE):
        return {"_comment": queue_comment(), "schema": QUEUE_SCHEMA,
                "candidates": []}
    with open(config.DISCOVERY_QUEUE_FILE) as fh:
        queue = json.load(fh)
    queue.setdefault("candidates", [])
    return queue


def queue_comment():
    return [
        "Candidate models found by pipeline/discover.py, awaiting review.",
        "",
        "This file is hand-edited, like registry.json. discover.py only ever",
        "appends new candidates and refreshes the fields of existing ones; it",
        "never sets a status and never edits registry.json.",
        "",
        "To review a row, set its status:",
        "  new       - not yet reviewed (what discover.py writes)",
        "  dismissed - not an scRNA-seq foundation model, stop showing it",
        "  added     - promoted into registry.json",
        "",
        "Add a 'note' to a row to record why. Dismissed rows stay here so the",
        "judgement survives; they are counted, not re-surfaced.",
        "",
        "matches_tracked_model flags a registry name appearing in the title.",
        "It is a hint, not a verdict -- check before dismissing on it.",
    ]


def merge(queue, found, names, today):
    """Fold this run's hits into the queue, preserving human decisions."""
    by_key = dict((c["key"], c) for c in queue["candidates"] if c.get("key"))
    added, refreshed = [], 0

    for key in sorted(found):
        hit = found[key]
        hit["matches_tracked_model"] = tracked_matches(hit["title"], names)
        hit["guessed_name"] = guess_name(hit["title"], hit.get("abstract"))
        existing = by_key.get(key)
        if existing:
            # Refresh the facts, keep the judgement.
            status = existing.get("status", "new")
            note = existing.get("note")
            first_seen = existing.get("first_seen", today)
            existing.clear()
            existing.update(hit)
            existing["first_seen"] = first_seen
            existing["status"] = status
            if note:
                existing["note"] = note
            existing["schema"] = QUEUE_SCHEMA
            refreshed += 1
        else:
            hit["first_seen"] = today
            hit["status"] = "new"
            hit["schema"] = QUEUE_SCHEMA
            queue["candidates"].append(hit)
            by_key[key] = hit
            added.append(hit)

    queue["candidates"].sort(
        key=lambda c: (c.get("date") or "", c.get("key") or ""), reverse=True)
    return added, refreshed


def main():
    today = datetime.date.today()
    today_iso = today.isoformat()
    terms = normalized_terms()

    state = {}
    if os.path.exists(config.DISCOVERY_FILE):
        with open(config.DISCOVERY_FILE) as fh:
            try:
                state = json.load(fh)
            except ValueError:
                state = {}

    # Incremental window: start where the last complete scan ended, minus an
    # overlap for late postings, and never more than the configured lookback.
    floor = today - datetime.timedelta(days=config.DISCOVERY_WINDOW_DAYS)
    scanned_through = state.get("biorxiv_scanned_through")
    if scanned_through:
        try:
            prev = datetime.date(*[int(x) for x in scanned_through.split("-")])
            start = prev - datetime.timedelta(days=config.DISCOVERY_OVERLAP_DAYS)
        except (TypeError, ValueError):
            start = floor
    else:
        start = floor
    if start < floor:
        start = floor

    print("Discovery scan  {}  ({} terms)".format(today_iso, len(terms)))
    print("")

    bio_hits, covered_through, complete = scan_biorxiv(start, today, terms)
    print("")
    arx_hits, arx_failures = scan_arxiv(floor.isoformat(), terms)
    print("")

    dois, names = tracked_facts()

    found = {}
    found.update(bio_hits)
    found.update(arx_hits)

    # Drop what the registry already covers, by DOI only.
    tracked = 0
    for key in list(found):
        if clean_doi(found[key].get("doi")) in dois:
            del found[key]
            tracked += 1

    queue = load_queue()
    queue["_comment"] = queue_comment()
    queue["schema"] = QUEUE_SCHEMA
    added, refreshed = merge(queue, found, names, today_iso)

    counts = {}
    for cand in queue["candidates"]:
        status = cand.get("status", "new")
        counts[status] = counts.get(status, 0) + 1

    queue["updated"] = today_iso
    queue["counts"] = counts
    with open(config.DISCOVERY_QUEUE_FILE, "w") as fh:
        json.dump(queue, fh, indent=1, sort_keys=False)
        fh.write("\n")

    # Advance the watermark to the last fully-paged chunk, not to today. A
    # throttled or budget-capped run still records the ground it covered, so
    # the next one resumes there instead of re-reading from the start.
    if covered_through is not None:
        previous = state.get("biorxiv_scanned_through") or ""
        if covered_through.isoformat() > previous:
            state["biorxiv_scanned_through"] = covered_through.isoformat()
    state["schema"] = QUEUE_SCHEMA
    state["last_run"] = today_iso
    state["last_run_complete"] = bool(complete) and not arx_failures
    state["terms"] = terms
    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)
    with open(config.DISCOVERY_FILE, "w") as fh:
        json.dump(state, fh, indent=2)

    print("{} matched, {} already tracked, {} new, {} refreshed".format(
        len(found) + tracked, tracked, len(added), refreshed))
    for cand in added:
        flag = ""
        if cand["matches_tracked_model"]:
            flag = "  [name matches {}]".format(", ".join(cand["matches_tracked_model"]))
        print("  + {:<10} {}{}".format(
            cand["source"], cand["title"][:72], flag))
    pending = counts.get("new", 0)
    print("\nQueue: {} awaiting review, {} dismissed, {} added.".format(
        pending, counts.get("dismissed", 0), counts.get("added", 0)))
    print("Wrote {}".format(config.DISCOVERY_QUEUE_FILE))
    if not complete:
        resume = state.get("biorxiv_scanned_through") or start.isoformat()
        print("bioRxiv window incomplete -- next run resumes from {}".format(
            resume))


if __name__ == "__main__":
    main()
