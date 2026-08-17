# Single-Cell Foundation Model Tracker

A dashboard that tracks every single-cell RNA-seq foundation model and measures
three things that usually disagree: how much a model is **cited**, how much it
is actually **downloaded and starred**, and how recently anyone **touched the
code**. It also shows *who* cites each model, and whether they applied it or
benchmarked it.

Data refreshes weekly from OpenAlex, the GitHub API, and the Hugging Face Hub.

## Why three metrics instead of one

Citation count alone rewards age. scBERT has 629 citations and has not had a
commit since December 2023; scPRINT has 45 citations and was updated last week.
Ranking either one above the other on citations alone tells you nothing about
whether you should run it. So each model gets a 0–100 score from four
normalized components:

> **score = 100 × (0.35·attention + 0.25·momentum + 0.20·usage + 0.20·openness)**

| Component | What it measures |
|---|---|
| **Attention** (×0.35) | Log-scaled total citations, deduplicated across every version of the model paper |
| **Momentum** (×0.25) | Citations gained recently — measured from weekly snapshots once enough history exists, and from the share of citations in the last two years before that |
| **Usage** (×0.20) | Hugging Face downloads plus GitHub stars — did anyone pull the weights, not just cite the paper |
| **Openness & upkeep** (×0.20) | Open weights, license permissiveness, and days since the last commit |

Sliders on the leaderboard re-weight everything live and write the weighting
into the URL, so a particular ranking is a shareable link (`…/#w=0.35,0.25,0.20,0.20`).

## Citations are deduplicated across paper versions

Most of these models have a bioRxiv preprint *and* a journal version, each with
its own DOI. A paper citing both would be counted twice by a naive sum. The
pipeline unions the citing works across every registered version and dedupes by
OpenAlex work ID:

- scGPT: naive sum 1,357 → **1,322 deduplicated** (35 papers cite both versions)

The gap is shown on every model page, because inflation from double-counting
hits the best-known models hardest — exactly the ones at the top of the table.

Two related data-quality rules:

- A citing record dated before the paper it cites is a metadata error. Those
  records stay in the total but are excluded from the year histogram; one
  mis-dated 2009 record otherwise stretches a sparkline across fifteen empty
  years and hides the real trend.
- A rate-limited API response is never treated as "missing." Silently reading a
  throttled request as a deleted repo would drop a model's stars to zero and
  quietly move it down the ranking.

## How citing articles are classified

Every citing paper is labelled from its title as **application** (used the
model), **benchmark** (evaluated or compared it), **extension** (built on it),
or **review**. The benchmark label is the useful one: several independent
evaluations report that these models do not always beat much simpler baselines,
and those papers are otherwise buried among hundreds of routine applications.

## The registry

`pipeline/registry.json` is the only hand-maintained file — there is no
ontology of "single-cell foundation model," so membership is a curation
decision. Each entry pins the paper versions (by title or by OpenAlex ID), the
GitHub repo, and the Hugging Face weights. `pipeline/resolve_ids.py` verifies
every one of those IDs against the live APIs and reports anything that fails to
resolve, so a renamed repo or a retracted DOI surfaces as an error rather than
as a silent zero.

## Layout

```
index.html  app.js  styles.css        static site, no build step
pipeline/
  registry.json      curated model registry (hand-edited)
  config.py          endpoints, weights, thresholds
  resolve_ids.py     verify every DOI / repo / weights id
  fetch_openalex.py  citations, yearly trend, citing articles
  fetch_github.py    stars, forks, last commit
  fetch_hf.py        weight downloads
  build_data.py      score, snapshot, write data/*.json
  run_all.py         orchestrates the above
data/
  models.json        one row per model
  citations.json     recent citing articles per model
  history.json       append-only weekly snapshots (drives deltas)
  meta.json          provenance
```

`data/history.json` is append-only and committed to the repo. Weekly deltas and
the momentum component cannot be backfilled from any API, so the snapshot is
written from the very first run even before anything reads it.

## Running it

```bash
pip install requests
python pipeline/run_all.py
python -m http.server 8000   # then open http://localhost:8000
```

The weekly GitHub Action (`.github/workflows/refresh-data.yml`) runs the same
pipeline every Monday at 06:00 UTC and commits any changed data.

---

Data: [OpenAlex](https://openalex.org/) ·
[GitHub API](https://docs.github.com/rest) ·
[Hugging Face Hub](https://huggingface.co/docs/hub/api).
Citation counts measure attention, not quality.
