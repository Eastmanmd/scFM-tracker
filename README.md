# Single-Cell Foundation Model Tracker

**Live site: https://eastmanmd.github.io/scFM-tracker/**

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
| **Momentum** (×0.25) | Citations gained in the last 365 days, counted from the publication date on each citing paper |
| **Usage** (×0.20) | Hugging Face downloads plus GitHub stars — did anyone pull the weights, not just cite the paper |
| **Openness & upkeep** (×0.20) | Open weights, license permissiveness, and days since the last commit |

Sliders on the leaderboard re-weight everything live and write the weighting
into the URL, so a particular ranking is a shareable link (`…/#w=0.35,0.25,0.20,0.20`).

## Momentum is counted, not inferred

Every citing record carries the citing paper's publication date, so the
trailing-year count is read straight off the corpus — exact on the first run,
and equally valid for a model added yesterday.

The earlier scheme switched between two different measures depending on how
much snapshot history had accumulated: an absolute citation delta once weekly
snapshots were deep enough, and the *share* of citations from the last two
years before that. A count and a ratio do not rank models the same way, so the
leaderboard would have reshuffled on whichever week the branch flipped, for a
reason no reader could see. The ratio was also nearly useless on its own terms
— it saturated at 1.0 for every model young enough that all of its citations
were recent, which was most of the field.

Weekly snapshots still drive the week-over-week deltas shown next to each
citation and star count.

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

## Which models are evaluated against each other

A citing paper labelled `benchmark` that cites two tracked models is an
independent evaluation covering both. Intersecting the citing corpus on that
label turns the field's own comparison record into a matrix — 81 of the 135
benchmarking papers cite two or more tracked models:

| Pair | Benchmarking papers citing both | Papers citing both, any use |
|---|---:|---:|
| scGPT · Geneformer | 56 | 658 |
| scGPT · scFoundation | 49 | 494 |
| Geneformer · scFoundation | 37 | 396 |
| scGPT · scBERT | 27 | 375 |

Clicking a cell lists the papers behind it, so "who has actually evaluated
these two together" is one click rather than a literature search. It costs no
extra API calls: the citing lists are already fetched and stored per model.

Two things the matrix deliberately does not claim:

- **It is co-citation by an evaluating paper, not a verified head-to-head
  result.** The label belongs to the citing paper, so a paper that evaluates
  one model and cites the other only in its introduction is counted.
- **An empty cell is missing evidence, not a verdict.** CellHermes and LangCell
  have no joint evaluation with anything on the list — which for models this
  recent is the expected state, and reading it as a poor result would be
  exactly backwards.

## How citing articles are classified

Every citing paper carries two independent labels, assigned from its title,
abstract, and OpenAlex topics.

**Use** — what the paper does with the model: **application** (used it),
**benchmark** (evaluated or compared it), **extension** (built on it), or
**review**. The benchmark label is the useful one: several independent
evaluations report that these models do not always beat much simpler baselines,
and those papers are otherwise buried among hundreds of routine applications.

**Field** — what kind of work the paper is: **method** (a new computational
tool or model), **biology** (a claim about cells, tissue, or disease),
**offtopic** (cites the model in passing, from outside the field), or
**unclear**. This axis exists because the first one could not answer the
question everyone actually asks. 79% of citing papers were landing in
`application`, mixing new ML tools in with genuine biology — the two things
worth telling apart.

The derived number is **biology share**: the fraction of a model's classified
citations that are biology work. Corpus-wide it is about 13%, and it is shown
per model on the leaderboard. `unclear` papers are excluded from that ratio
rather than counted against biology — an abstention is an unknown, not a no.

Two limits are worth stating plainly:

- **This classifies the citing paper, not the citation.** A biology paper that
  name-checks a model once in its introduction still counts as a biology
  citation. Separating use from mention needs full text, which OpenAlex does
  not carry.
- **The classifier is rules-based and imperfect.** Measured against 92
  hand-labelled papers: 89% accurate overall, 95% on the papers it chose to
  call, abstaining on 7%. It is weakest on papers that are genuinely both — a
  new method whose whole point is a biological finding.

Abstracts cover 83–93% of citing works and ride along in the same paged
OpenAlex request, so the second axis costs no extra API calls.

---

Data: [OpenAlex](https://openalex.org/) ·
[GitHub API](https://docs.github.com/rest) ·
[Hugging Face Hub](https://huggingface.co/docs/hub/api).
Citation counts measure attention, not quality.
