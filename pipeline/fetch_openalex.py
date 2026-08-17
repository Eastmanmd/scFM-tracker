"""Pull citation counts, yearly trends, and citing articles from OpenAlex.

A model usually has two papers (preprint + journal version). Citations are the
union of the works citing *any* version, deduped by OpenAlex work id -- a
review that cites both the bioRxiv and the Nature Methods scGPT paper counts
once, not twice. Summing per-version cited_by_count instead would inflate the
best-known models the most, which is exactly the ranking we care about.
"""
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

SELECT = ",".join([
    "id", "doi", "title", "publication_year", "publication_date",
    "type", "cited_by_count", "primary_location", "authorships",
])

# Title keywords that say *how* the citing paper used the model.
BENCHMARK_TERMS = ("benchmark", "evaluat", "comparison", "comparative",
                   "assessing", "assessment", "limits of", "do ", "critical")
REVIEW_TERMS = ("review", "survey", "perspective", "opportunities", "landscape")
EXTENSION_TERMS = ("fine-tun", "finetun", "building on", "extend", "adapt",
                   "improv", "distill")


def classify(work):
    """Label a citing work as benchmark / review / extension / application."""
    title = (work.get("title") or "").lower()
    if work.get("type") == "review" or any(t in title for t in REVIEW_TERMS):
        return "review"
    if any(t in title for t in BENCHMARK_TERMS):
        return "benchmark"
    if any(t in title for t in EXTENSION_TERMS):
        return "extension"
    return "application"


def get(url, params, attempts=6):
    """GET with backoff that honours Retry-After.

    Paging citing works is the heaviest thing this pipeline does, so OpenAlex
    will throttle it. Giving up on the first 429 would truncate a model's
    citation list and silently under-report it.
    """
    delay = 5.0
    for attempt in range(attempts):
        resp = requests.get(url, params=params, timeout=90)
        if resp.status_code == 200:
            return resp.json()
        if attempt < attempts - 1 and resp.status_code in (429, 500, 502, 503):
            wait = delay
            try:
                wait = max(delay, float(resp.headers.get("Retry-After") or 0))
            except ValueError:
                pass
            print("    http {} -- waiting {:.0f}s".format(resp.status_code, wait),
                  flush=True)
            time.sleep(wait)
            delay *= 2
            continue
        resp.raise_for_status()
    raise RuntimeError("unreachable")


def fetch_work(work_id):
    """Full record for one paper, including counts_by_year."""
    data = get("{}/works/{}".format(config.OPENALEX_BASE, work_id),
               {"mailto": config.OPENALEX_MAILTO})
    time.sleep(config.OPENALEX_DELAY)
    return data


def fetch_citing(work_id):
    """Every work citing work_id, via cursor pagination."""
    out = []
    cursor = "*"
    while cursor:
        page = get("{}/works".format(config.OPENALEX_BASE), {
            "filter": "cites:{}".format(work_id),
            "per-page": config.OPENALEX_PER_PAGE,
            "cursor": cursor,
            "select": SELECT,
            "mailto": config.OPENALEX_MAILTO,
        })
        out.extend(page.get("results", []))
        cursor = page.get("meta", {}).get("next_cursor")
        time.sleep(config.OPENALEX_DELAY)
    return out


def slim(work):
    """Keep only what the site renders."""
    loc = work.get("primary_location") or {}
    source = (loc.get("source") or {}).get("display_name")
    authors = work.get("authorships") or []
    first = authors[0]["author"]["display_name"] if authors else None
    return {
        "id": work["id"].rsplit("/", 1)[-1],
        "doi": work.get("doi"),
        "title": work.get("title"),
        "year": work.get("publication_year"),
        "date": work.get("publication_date"),
        "venue": source,
        "first_author": first,
        "n_authors": len(authors),
        "cited_by_count": work.get("cited_by_count"),
        "use": classify(work),
    }


def main():
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)
    with open(config.RESOLVED_FILE) as fh:
        resolved = json.load(fh)

    # Citing lists are cached per paper and only re-paged when the paper's
    # citation count actually moves. Most weeks most papers are unchanged, so
    # this turns ~30 paginated requests into a handful.
    citing_cache = {}
    if os.path.exists(config.CITING_CACHE_FILE):
        with open(config.CITING_CACHE_FILE) as fh:
            citing_cache = json.load(fh)

    out = {}
    refetched = 0
    for model in registry["models"]:
        mid = model["id"]
        papers = resolved.get(mid, {}).get("papers", [])
        if not papers:
            print("{}: no resolved papers, skipping".format(mid))
            continue

        versions = []
        counts_by_year = {}
        citing = {}

        for paper in papers:
            work = fetch_work(paper["openalex_id"])
            versions.append({
                "openalex_id": paper["openalex_id"],
                "doi": paper.get("doi"),
                "title": work.get("title"),
                "venue": paper.get("venue"),
                "year": work.get("publication_year"),
                "date": work.get("publication_date"),
                "type": work.get("type"),
                "cited_by_count": work.get("cited_by_count"),
            })
            wid = paper["openalex_id"]
            count = work.get("cited_by_count") or 0
            cached = citing_cache.get(wid)
            if cached and cached.get("cited_by_count") == count:
                records = cached["records"]
            else:
                records = [slim(w) for w in fetch_citing(wid)]
                citing_cache[wid] = {"cited_by_count": count, "records": records}
                refetched += 1
            for rec in records:
                citing[rec["id"]] = rec

        # Rebuild the year histogram from the deduped citing set so the
        # sparkline and the headline number always agree.
        #
        # A handful of OpenAlex records carry a publication year predating the
        # paper they cite (bad source metadata). They stay in the total but are
        # kept out of the histogram -- one 2009 record stretches a sparkline
        # across fifteen empty years and hides the actual trend.
        paper_years = [v["year"] for v in versions if v.get("year")]
        floor = (min(paper_years) - 1) if paper_years else 0
        misdated = 0
        for rec in citing.values():
            year = rec.get("year")
            if not year:
                continue
            if year < floor:
                misdated += 1
                continue
            counts_by_year[year] = counts_by_year.get(year, 0) + 1
        counts_by_year = dict((y, c) for y, c in counts_by_year.items() if y >= floor)

        records = sorted(citing.values(),
                         key=lambda r: (r.get("date") or "", r.get("title") or ""),
                         reverse=True)
        use_counts = {}
        for rec in records:
            use_counts[rec["use"]] = use_counts.get(rec["use"], 0) + 1

        out[mid] = {
            "versions": versions,
            "citations_total": len(citing),
            "citations_naive_sum": sum(v["cited_by_count"] or 0 for v in versions),
            "counts_by_year": {str(k): v for k, v in sorted(counts_by_year.items())},
            "misdated_citations": misdated,
            "use_counts": use_counts,
            "citing": records[:config.CITING_PER_MODEL],
        }
        print("{:<18} {:>5} citations ({} versions, naive sum {})  {}".format(
            mid, out[mid]["citations_total"], len(versions),
            out[mid]["citations_naive_sum"], use_counts))

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)
    with open(config.OPENALEX_FILE, "w") as fh:
        json.dump(out, fh)
    with open(config.CITING_CACHE_FILE, "w") as fh:
        json.dump(citing_cache, fh)
    print("\n{} paper(s) re-paged, {} served from cache.".format(
        refetched, len(citing_cache) - refetched))
    print("Wrote {}".format(config.OPENALEX_FILE))


if __name__ == "__main__":
    main()
