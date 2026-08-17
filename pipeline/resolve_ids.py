"""Resolve and verify every external id in the registry.

For each model this checks that:
  * each paper title matches a real OpenAlex work (recording its id + DOI),
  * the GitHub repo exists,
  * each Hugging Face model id exists.

Writes cache/resolved.json and prints a report. Anything printed as WEAK or
MISSING needs a human to fix registry.json before the numbers can be trusted --
an unresolved paper silently means zero citations, which is worse than an error.
"""
import difflib
import json
import os
import re
import sys
import time
try:
    from urllib.parse import quote
except ImportError:                      # pragma: no cover - py2 safety net
    from urllib import quote

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

STRONG_MATCH = 0.90
WEAK_MATCH = 0.60


def normalize(text):
    return re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()).strip()


def similarity(a, b):
    return difflib.SequenceMatcher(None, normalize(a), normalize(b)).ratio()


def openalex_get(url, params, attempts=5):
    """GET with backoff. OpenAlex answers 429 under burst load, and a crash
    there would leave the registry half-verified."""
    delay = 3.0
    for attempt in range(attempts):
        resp = requests.get(url, params=params, timeout=60)
        if resp.status_code == 200:
            return resp.json()
        if attempt < attempts - 1 and resp.status_code in (429, 500, 502, 503):
            wait = float(resp.headers.get("Retry-After") or delay)
            time.sleep(wait)
            delay *= 2
            continue
        resp.raise_for_status()
    raise RuntimeError("unreachable")


def openalex_search(title):
    """Return the best-matching OpenAlex work for a paper title."""
    url = "{}/works".format(config.OPENALEX_BASE)
    params = {
        "filter": "title.search:{}".format(title),
        "per-page": 10,
        "select": "id,doi,title,publication_year,cited_by_count,type",
        "mailto": config.OPENALEX_MAILTO,
    }
    results = openalex_get(url, params).get("results", [])
    if not results:
        return None, 0.0
    scored = [(similarity(title, w.get("title")), w) for w in results]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    best_score, best = scored[0]
    return best, best_score


def get_json(url, headers=None, attempts=4):
    """GET returning (payload, status). Retries throttling; 404 is a real answer.

    Never collapse a 403/429 into 'missing' -- a throttled request looks
    identical to a deleted repo, and that difference decides whether a model
    silently drops out of the table.
    """
    delay = 2.0
    for attempt in range(attempts):
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code == 200:
            return resp.json(), 200
        if resp.status_code == 404:
            return None, 404
        if resp.status_code in (403, 429, 500, 502, 503) and attempt < attempts - 1:
            time.sleep(delay)
            delay *= 2
            continue
        return None, resp.status_code
    return None, 0


def openalex_fetch(work_id):
    """Fetch one work by its OpenAlex id."""
    try:
        return openalex_get("{}/works/{}".format(config.OPENALEX_BASE, work_id),
                            {"mailto": config.OPENALEX_MAILTO})
    except requests.HTTPError:
        return None


def check_github(repo):
    headers = {"Accept": "application/vnd.github+json"}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = "Bearer {}".format(config.GITHUB_TOKEN)
    return get_json("{}/repos/{}".format(config.GITHUB_API, repo), headers)


def check_hf(model_id):
    return get_json("{}/models/{}".format(config.HF_API, quote(model_id)))


def registry_fingerprint(model):
    """Identity of the hand-curated inputs for one model.

    If none of these changed, last week's resolution is still valid and the
    weekly job can skip ~19 OpenAlex title searches -- which is what was
    getting the pipeline throttled.
    """
    return json.dumps({
        "papers": [[p.get("title"), p.get("openalex_id")] for p in model["papers"]],
        "github": model.get("github"),
        "hf": model.get("hf", []),
    }, sort_keys=True)


def main():
    force = "--force" in sys.argv or os.environ.get("FORCE_RESOLVE")
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)

    cached = {}
    if os.path.exists(config.RESOLVED_FILE) and not force:
        with open(config.RESOLVED_FILE) as fh:
            cached = json.load(fh)

    resolved = {}
    problems = []
    reused = 0

    for model in registry["models"]:
        mid = model["id"]
        fingerprint = registry_fingerprint(model)
        prior = cached.get(mid)
        if prior and prior.get("fingerprint") == fingerprint:
            resolved[mid] = prior
            reused += 1
            continue

        print("\n{}  ({})".format(model["name"], mid))
        entry = {"fingerprint": fingerprint, "papers": [], "github": None, "hf": []}

        for paper in model["papers"]:
            if paper.get("openalex_id"):
                # Pinned by id -- skips title search, which is the only way to
                # attach a version whose title differs from the canonical one.
                work, score = openalex_fetch(paper["openalex_id"]), 1.0
            else:
                work, score = openalex_search(paper["title"])
            time.sleep(config.OPENALEX_DELAY)
            if work is None or score < WEAK_MATCH:
                print("  paper   MISSING  {!r}".format(paper["title"][:70]))
                problems.append((mid, "paper not found: " + paper["title"]))
                continue
            flag = "ok  " if score >= STRONG_MATCH else "WEAK"
            work_id = work["id"].rsplit("/", 1)[-1]
            print("  paper   {}  {:.2f}  {}  {}  cites={}".format(
                flag, score, work_id, work.get("publication_year"),
                work.get("cited_by_count")))
            print("          -> {}".format((work.get("title") or "")[:78]))
            if score < STRONG_MATCH:
                problems.append((mid, "weak title match: {} -> {}".format(
                    paper["title"][:50], (work.get("title") or "")[:50])))
            entry["papers"].append({
                "requested_title": paper["title"],
                "venue": paper.get("venue"),
                "openalex_id": work_id,
                "doi": work.get("doi"),
                "matched_title": work.get("title"),
                "year": work.get("publication_year"),
                "cited_by_count": work.get("cited_by_count"),
                "type": work.get("type"),
                "match_score": round(score, 3),
            })

        if model.get("github"):
            repo, status = check_github(model["github"])
            time.sleep(config.GITHUB_DELAY)
            if repo is None:
                label = "MISSING" if status == 404 else "ERROR  "
                print("  github  {}  {}  (http {})".format(
                    label, model["github"], status))
                problems.append((mid, "github {} (http {}): {}".format(
                    "not found" if status == 404 else "unreachable",
                    status, model["github"])))
            else:
                print("  github  ok    {}  stars={}  license={}".format(
                    repo["full_name"], repo["stargazers_count"],
                    (repo.get("license") or {}).get("spdx_id")))
                entry["github"] = repo["full_name"]

        for hf_id in model.get("hf", []):
            info, status = check_hf(hf_id)
            time.sleep(config.HF_DELAY)
            if info is None:
                label = "MISSING" if status == 404 else "ERROR  "
                print("  hf      {}  {}  (http {})".format(label, hf_id, status))
                problems.append((mid, "hf {} (http {}): {}".format(
                    "not found" if status == 404 else "unreachable",
                    status, hf_id)))
            else:
                print("  hf      ok    {}  downloads={}  likes={}".format(
                    hf_id, info.get("downloads"), info.get("likes")))
                entry["hf"].append(hf_id)

        resolved[mid] = entry

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)
    with open(config.RESOLVED_FILE, "w") as fh:
        json.dump(resolved, fh, indent=2)

    print("\n" + "=" * 72)
    if reused:
        print("{} model(s) unchanged in the registry -- reused cached ids. "
              "Use --force to re-verify everything.".format(reused))
    if problems:
        print("{} item(s) need attention in registry.json:".format(len(problems)))
        for mid, msg in problems:
            print("  [{}] {}".format(mid, msg))
    else:
        print("All ids resolved cleanly.")
    print("Wrote {}".format(config.RESOLVED_FILE))


if __name__ == "__main__":
    main()
