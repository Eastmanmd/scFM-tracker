"""Assemble the cached API pulls into the JSON the site reads.

Writes:
  data/models.json     one row per model: specs, metrics, score breakdown
  data/citations.json  recent citing articles per model, labelled on both axes
  data/history.json    append-only weekly snapshot (drives deltas + momentum)
  data/meta.json       provenance and corpus-level summary
"""
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

PERMISSIVE = {"MIT", "APACHE-2.0", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "ISC"}
COPYLEFT = {"GPL-3.0", "GPL-2.0", "AGPL-3.0", "LGPL-3.0"}


def load(path, default=None):
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    return default if default is not None else {}


def normalize(values):
    """Scale a dict of raw numbers to 0-1. Flat input maps to 0."""
    if not values:
        return {}
    lo, hi = min(values.values()), max(values.values())
    if hi - lo < 1e-9:
        return dict((k, 0.0) for k in values)
    return dict((k, (v - lo) / (hi - lo)) for k, v in values.items())


def biology_share(domain_counts):
    """Share of *classified* citations that are biology work.

    "unclear" is excluded from the denominator rather than counted against
    biology. Papers the classifier abstained on are unknown, not non-biology,
    and burying them in the denominator would understate the number by however
    much the classifier happens to be hedging that week. The count of
    abstentions travels alongside so the reader can see what was set aside.
    """
    method = domain_counts.get("method", 0)
    bio = domain_counts.get("biology", 0)
    decided = method + bio
    if not decided:
        return None
    return round(bio / float(decided), 3)


def license_score(spdx, weights_open):
    if not weights_open:
        return 0.0
    key = (spdx or "").upper()
    if key in PERMISSIVE:
        return 1.0
    if key in COPYLEFT:
        return 0.7
    return 0.3          # NOASSERTION / unstated -- usable but legally unclear


def upkeep_score(gh, hfd, today):
    """Days since the model was last touched, from GitHub or Hugging Face.

    Geneformer and friends ship weights through Hugging Face with no GitHub
    repo; without the HF fallback they would read as unmaintained purely for
    choosing a different host.
    """
    stamps = []
    if gh and gh.get("pushed_at"):
        stamps.append(gh["pushed_at"][:10])
    for repo in (hfd or {}).get("repos", []):
        if repo.get("last_modified"):
            stamps.append(repo["last_modified"][:10])
    if not stamps:
        return 0.0, None, "unknown"
    pushed = max(datetime.date(*[int(x) for x in s.split("-")]) for s in stamps)
    days = (today - pushed).days
    if gh and gh.get("archived"):
        return 0.0, days, "archived"
    if days <= config.STALE_DAYS:
        return 1.0, days, "active"
    if days <= 365:
        return 0.6, days, "slowing"
    return 0.2, days, "dormant"


MIN_PRIOR_FOR_VELOCITY = 10


def velocity(counts_by_year, this_year):
    """Compare the last 3 years of citations against the 3 before them.

    Models younger than about six years have a prior window that mostly
    predates their own publication, which yields nonsense ratios (scGPT read as
    32x). Below a usable baseline the model is simply 'new'.
    """
    counts = dict((int(k), v) for k, v in counts_by_year.items())
    recent = sum(counts.get(y, 0) for y in range(this_year - 2, this_year + 1))
    prior = sum(counts.get(y, 0) for y in range(this_year - 5, this_year - 2))
    if prior < MIN_PRIOR_FOR_VELOCITY:
        return ("new" if recent else "quiet"), None
    ratio = recent / float(prior)
    if ratio >= 1.5:
        label = "surging"
    elif ratio >= 0.7:
        label = "steady"
    else:
        label = "declining"
    return label, round(ratio, 2)


def main():
    registry = load(config.REGISTRY_FILE)
    openalex = load(config.OPENALEX_FILE)
    github = load(config.GITHUB_FILE)
    hf = load(config.HF_FILE)
    history = load(config.HISTORY_FILE, {"snapshots": []})

    today = datetime.date.today()
    this_year = today.year
    today_iso = today.isoformat()

    # ---- previous snapshot, for weekly deltas -------------------------------
    snapshots = history.get("snapshots", [])
    previous = None
    for snap in reversed(snapshots):
        if snap["date"] != today_iso:
            previous = snap
            break
    # The snapshot closest to MOMENTUM_WEEKS ago drives the momentum component.
    target = today - datetime.timedelta(weeks=config.MOMENTUM_WEEKS)
    baseline = None
    for snap in snapshots:
        snap_date = datetime.date(*[int(x) for x in snap["date"].split("-")])
        if snap_date <= target and snap["date"] != today_iso:
            baseline = snap

    rows = []
    citations_out = {}

    for model in registry["models"]:
        mid = model["id"]
        oa = openalex.get(mid, {})
        gh = github.get(mid)
        hfd = hf.get(mid)

        citations = oa.get("citations_total", 0)
        counts_by_year = oa.get("counts_by_year", {})
        stars = gh.get("stars", 0) if gh else 0
        downloads = hfd.get("downloads", 0) if hfd else 0
        upkeep, days_since_push, upkeep_label = upkeep_score(gh, hfd, today)
        vel_label, vel_ratio = velocity(counts_by_year, this_year)

        prev_row = (previous or {}).get("models", {}).get(mid, {})
        base_row = (baseline or {}).get("models", {}).get(mid, {})

        rows.append({
            "id": mid,
            "name": model["name"],
            "org": model["org"],
            "year": model["year"],
            "notes": model.get("notes"),
            "params": model.get("params"),
            "cells": model.get("cells"),
            "tasks": model.get("tasks", []),
            "weights_open": model.get("weights_open", False),
            "license": (gh or {}).get("license") or model.get("license"),
            "papers": oa.get("versions", []),
            "citations": citations,
            "citations_naive_sum": oa.get("citations_naive_sum", 0),
            "counts_by_year": counts_by_year,
            "use_counts": oa.get("use_counts", {}),
            "domain_counts": oa.get("domain_counts", {}),
            "biology_share": biology_share(oa.get("domain_counts", {})),
            "abstract_coverage": oa.get("abstract_coverage", 0.0),
            "velocity": vel_label,
            "velocity_ratio": vel_ratio,
            "github": gh,
            "stars": stars,
            "upkeep": upkeep_label,
            "days_since_push": days_since_push,
            "hf": hfd,
            "downloads": downloads,
            "citations_delta": (citations - prev_row["citations"]
                                if "citations" in prev_row else None),
            "stars_delta": (stars - prev_row["stars"]
                            if "stars" in prev_row else None),
            "citations_delta_window": (citations - base_row["citations"]
                                       if "citations" in base_row else None),
            "_upkeep_raw": upkeep,
        })
        # Drop the classifier's raw inputs before they reach the browser --
        # abstracts alone would multiply data/citations.json several times over
        # for text nothing on the page renders.
        citations_out[mid] = [
            dict((k, v) for k, v in rec.items()
                 if k not in ("abstract", "topic_names", "has_abstract"))
            for rec in oa.get("citing", [])
        ]

    # ---- score components ---------------------------------------------------
    attention = normalize(dict((r["id"], math.log1p(r["citations"])) for r in rows))
    usage = normalize(dict(
        (r["id"], math.log1p(r["stars"]) + math.log1p(r["downloads"])) for r in rows))

    # Momentum prefers a real measured delta; until history is deep enough it
    # falls back to the share of citations arriving in the last two years.
    have_baseline = any(r["citations_delta_window"] is not None for r in rows)
    if have_baseline:
        momentum_raw = dict(
            (r["id"], math.log1p(max(0, r["citations_delta_window"] or 0)))
            for r in rows)
        momentum_basis = "measured {}-week citation delta".format(config.MOMENTUM_WEEKS)
    else:
        def recent_share(row):
            counts = dict((int(k), v) for k, v in row["counts_by_year"].items())
            recent = sum(counts.get(y, 0) for y in (this_year, this_year - 1))
            return recent / float(row["citations"]) if row["citations"] else 0.0
        momentum_raw = dict((r["id"], recent_share(r)) for r in rows)
        momentum_basis = "share of citations from the last two years (no history yet)"
    momentum = normalize(momentum_raw)

    openness = {}
    for row in rows:
        openness[row["id"]] = (
            (1.0 if row["weights_open"] else 0.0) * 0.4
            + license_score(row["license"], row["weights_open"]) * 0.25
            + row["_upkeep_raw"] * 0.35
        )

    weights = config.SCORE_WEIGHTS
    for row in rows:
        parts = {
            "attention": attention.get(row["id"], 0.0),
            "momentum": momentum.get(row["id"], 0.0),
            "usage": usage.get(row["id"], 0.0),
            "openness": openness.get(row["id"], 0.0),
        }
        row["components"] = dict((k, round(v, 4)) for k, v in parts.items())
        row["score"] = round(100 * sum(parts[k] * weights[k] for k in weights), 1)
        del row["_upkeep_raw"]

    rows.sort(key=lambda r: r["score"], reverse=True)
    for i, row in enumerate(rows, 1):
        row["rank"] = i

    # ---- append today's snapshot -------------------------------------------
    snapshot = {
        "date": today_iso,
        "models": dict((r["id"], {"citations": r["citations"],
                                  "stars": r["stars"],
                                  "downloads": r["downloads"],
                                  "biology_share": r["biology_share"]})
                       for r in rows),
    }
    snapshots = [s for s in snapshots if s["date"] != today_iso] + [snapshot]
    snapshots.sort(key=lambda s: s["date"])

    if not os.path.isdir(config.DATA_DIR):
        os.makedirs(config.DATA_DIR)

    with open(config.HISTORY_FILE, "w") as fh:
        json.dump({"snapshots": snapshots}, fh, indent=1)
    with open(os.path.join(config.DATA_DIR, "models.json"), "w") as fh:
        json.dump({"models": rows}, fh)
    with open(os.path.join(config.DATA_DIR, "citations.json"), "w") as fh:
        json.dump(citations_out, fh)

    total_citations = sum(r["citations"] for r in rows)
    use_totals = {}
    for row in rows:
        for key, count in row["use_counts"].items():
            use_totals[key] = use_totals.get(key, 0) + count
    # Per-model tallies double-count any paper citing more than one model, so
    # the corpus figure comes from the deduped count the fetcher writes.
    corpus = openalex.get("_corpus", {})
    domain_totals = corpus.get("domain_counts", {})

    meta = {
        "updated": today_iso,
        "models_tracked": len(rows),
        "total_citations": total_citations,
        "open_weights": sum(1 for r in rows if r["weights_open"]),
        "actively_maintained": sum(1 for r in rows if r["upkeep"] == "active"),
        "weights": weights,
        "momentum_basis": momentum_basis,
        "history_depth": len(snapshots),
        "use_totals": use_totals,
        "domain_totals": domain_totals,
        "biology_share": biology_share(domain_totals),
        "unique_citing_works": corpus.get("unique_citing_works", 0),
        "sources": ["OpenAlex", "GitHub", "Hugging Face Hub"],
    }
    with open(os.path.join(config.DATA_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)

    print("{:<4}{:<20}{:>7}{:>8}{:>9}{:>8}  {}".format(
        "#", "model", "score", "cites", "stars", "dl/30d", "upkeep"))
    for row in rows:
        print("{:<4}{:<20}{:>7}{:>8}{:>9}{:>8}  {} / {}".format(
            row["rank"], row["name"][:19], row["score"], row["citations"],
            row["stars"], row["downloads"], row["upkeep"], row["velocity"]))
    print("\nmomentum basis: {}".format(momentum_basis))
    print("history depth: {} snapshot(s)".format(len(snapshots)))


if __name__ == "__main__":
    main()
