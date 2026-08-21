"""Pull citation counts, yearly trends, and citing articles from OpenAlex.

A model usually has two papers (preprint + journal version). Citations are the
union of the works citing *any* version, deduped by OpenAlex work id -- a
review that cites both the bioRxiv and the Nature Methods scGPT paper counts
once, not twice. Summing per-version cited_by_count instead would inflate the
best-known models the most, which is exactly the ranking we care about.

Each citing work is labelled on two axes by pipeline/classify.py: what it does
with the model (use) and what kind of work it is (domain). Abstracts and topics
feed the second axis and cost nothing extra -- they ride along in the same
paged request.
"""
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify
import config

SELECT = ",".join([
    "id", "doi", "title", "publication_year", "publication_date",
    "type", "cited_by_count", "primary_location", "authorships",
    # Free with the same page of results, and the only inputs that make the
    # method/biology split better than a coin flip on short titles.
    "abstract_inverted_index", "primary_topic", "topics",
])

# Bumped whenever slim() changes shape, so cached citing lists built by an
# older pipeline are re-paged instead of silently serving records that lack
# the newer fields.
CACHE_SCHEMA = 3


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
    """Keep what the site renders, plus what re-labelling needs.

    The abstract and topic stay on the cached record so the classifier can be
    changed and re-run against the existing corpus without re-paging OpenAlex.
    build_data.py strips both before writing data/citations.json -- the site
    never needs them, and they would multiply the payload the browser fetches.
    """
    loc = work.get("primary_location") or {}
    source = (loc.get("source") or {}).get("display_name")
    authors = work.get("authorships") or []
    first = authors[0]["author"]["display_name"] if authors else None
    use, domain, confidence, has_abstract = classify.classify(work)
    primary = work.get("primary_topic") or {}
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
        "use": use,
        "domain": domain,
        "domain_confidence": confidence,
        "has_abstract": has_abstract,
        "abstract": classify.abstract_text(work.get("abstract_inverted_index")),
        "topic": primary.get("display_name"),
        "topic_names": classify.topic_names(work),
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
    corpus = {}          # work id -> domain, deduped across every model
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
            if (cached and cached.get("cited_by_count") == count
                    and cached.get("schema") == CACHE_SCHEMA):
                records = cached["records"]
            else:
                records = [slim(w) for w in fetch_citing(wid)]
                citing_cache[wid] = {"cited_by_count": count,
                                     "schema": CACHE_SCHEMA,
                                     "records": records}
                refetched += 1
            for rec in records:
                citing[rec["id"]] = rec
                corpus[rec["id"]] = rec["domain"]

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
        domain_counts = {}
        with_abstract = 0
        for rec in records:
            use_counts[rec["use"]] = use_counts.get(rec["use"], 0) + 1
            domain_counts[rec["domain"]] = domain_counts.get(rec["domain"], 0) + 1
            if rec.get("has_abstract"):
                with_abstract += 1

        out[mid] = {
            "versions": versions,
            "citations_total": len(citing),
            "citations_naive_sum": sum(v["cited_by_count"] or 0 for v in versions),
            "counts_by_year": {str(k): v for k, v in sorted(counts_by_year.items())},
            "misdated_citations": misdated,
            "use_counts": use_counts,
            "domain_counts": domain_counts,
            "abstract_coverage": (round(with_abstract / float(len(records)), 3)
                                  if records else 0.0),
            # Full list, unsliced. build_data.py decides what ships upfront
            # and what goes into the lazily-fetched per-model file.
            "citing": records,
        }
        print("{:<18} {:>5} citations ({} versions, naive sum {})".format(
            mid, out[mid]["citations_total"], len(versions),
            out[mid]["citations_naive_sum"]))
        print("{:<18} {}  abstracts {:.0%}".format(
            "", domain_counts, out[mid]["abstract_coverage"]))

    # Corpus totals are counted over unique work ids, not summed across models.
    # A review citing six of these models is one paper, and summing per-model
    # tallies would let the most-cited models drag the headline share around.
    corpus_counts = {}
    for domain in corpus.values():
        corpus_counts[domain] = corpus_counts.get(domain, 0) + 1
    out["_corpus"] = {"domain_counts": corpus_counts,
                      "unique_citing_works": len(corpus)}
    print("\ncorpus: {} unique citing works  {}".format(len(corpus), corpus_counts))

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
