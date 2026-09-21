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
whether you should run it. So each model gets a 0–100 score from five
components:

> **score = 100 × (0.35·attention + 0.25·momentum + 0.20·usage + 0.10·openness + 0.10·runnability)**

| Component | What it measures |
|---|---|
| **Attention** (×0.35) | Log-scaled total citations, deduplicated across every version of the model paper |
| **Momentum** (×0.25) | Citations gained in the last 365 days, counted from the publication date on each citing paper |
| **Usage** (×0.20) | Hugging Face downloads plus GitHub stars — did anyone pull the weights, not just cite the paper |
| **Openness & upkeep** (×0.10) | Open weights, license permissiveness, and days since the last commit |
| **Runnability** (×0.10) | Packaged, pinned, released, documented, and answered — see below |

Runnability's weight came out of openness rather than out of the citation
components: both answer "can I use this", so the practical-usability half of
the score still totals 0.20, and attention, momentum and usage are weighted
exactly as they always were.

Sliders on the leaderboard re-weight everything live and write the weighting
into the URL, so a particular ranking is a shareable link (`…/#w=0.35,0.25,0.20,0.20`).

## Can you actually run it?

Citations say the field noticed a model. Stars say people bookmarked it. The
last-commit date says someone still touches the code. None of them answer what
you ask before spending an afternoon on one of these — so five signals do:

| Signal | Weight | Read from |
|---|---:|---|
| **installable** | 0.25 | a PyPI package whose metadata links back to this model's repo |
| **env** | 0.20 | requirements.txt / environment.yml / pyproject.toml / Dockerfile |
| **release** | 0.15 | a tagged GitHub release, or a tagged Hugging Face revision |
| **tutorials** | 0.15 | notebooks shipped with the code (3 earns full marks) |
| **responsive** | 0.25 | an issue or discussion resolved in the last 90 days |

Every signal is read from **both** GitHub and Hugging Face and merged. That is
not a detail: Geneformer ships no GitHub repository, and an earlier
GitHub-only version left it unmeasured — which, under the renormalizing scorer
below, quietly moved it to #1 for having nothing to fail at. Measured properly
on its Hugging Face repo (8 notebooks, a requirements.txt, discussions answered
this quarter, no PyPI package, no tags) it scores 60, and scGPT keeps the top
spot. Only tGPT, published on neither host, goes unmeasured.

**A package counts only when it links back to the model's own repository.**
Name matching alone is how a model gets credited with someone else's release:
PyPI's `uce` belongs to `lmrck/dnb`, `scfoundation` to a different author's
`scFoundationModels`, and `scbert` to an unrelated `SCBert`. All three are
correctly rejected. The cost is the opposite error — scPRINT publishes from its
author's personal namespace and `arc-state` ships no URLs at all — so those two
are named by hand in `registry.json` rather than guessed.

**A signal that could not be read is dropped, never failed.** The remaining
weights are renormalized, so a throttled request never quietly reads as "no
notebooks, no releases, no answers". The same rule applies one level up: a
model missing a whole component is scored on the components it has, and its
model page says so rather than showing a zero bar.

Two things this does not claim. Runnability is not quality — a research repo
with no package can still be the right thing to read. And "issues answered" is
binary on purpose: that somebody replied this quarter is supportable, while
ranking seven closed issues above two mostly measures how much traffic a repo
gets.

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
- **Known, unfixed:** citing works are deduplicated across versions of the
  *model* paper, but not across versions of the *citing* paper. A citing paper
  with a preprint and three reviewed versions counts four times toward the
  model's total. The changelog works around it; the headline counts do not.

## What changed this week

Every refresh is diffed against the one before it. `build_data.py` writes the
result to `data/changelog.json`, and `make_feed.py` publishes it as
[`feed.xml`](feed.xml) — an Atom feed with one entry per refresh, so the card on
the leaderboard and the feed can never disagree.

Reported: models joining the registry, rank moves, repositories going quiet or
being archived, licence changes, citation milestones, newly indexed
benchmarking papers, and the first time two models are jointly evaluated.

Three decisions make the difference between a feed worth keeping and one that
gets muted:

- **A rank move must clear two places *and* half a score point.** Models a
  tenth of a point apart trade places on normalization noise most weeks.
  Reporting that would bury the weeks something real happened.
- **A field with no previous value is unknown, not changed.** Rank, licence and
  upkeep were added to the weekly snapshot when this landed, so the first run
  after deployment publishes a baseline entry rather than announcing all 19
  models at once.
- **"New" means new to this tracker, not newly published.** Every citing record
  carries `first_seen`, stamped when it enters the corpus, so a 2024 paper
  OpenAlex indexed last Tuesday is reported the week it arrives instead of
  being filed under a week nobody is reading.

One thing this surfaced: OpenAlex stores each reviewed-preprint version as its
own work. *Benchmarking biochemical networks generated by large language
models* is four records — a bioRxiv preprint and three eLife versions — which
would announce the same paper for four weeks running. The changelog collapses
them by title. (Citation totals elsewhere on the site still count each work id;
see the note below.)

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

## How new models get found

The registry is curated by hand, and stays that way — whether something is a
single-cell RNA-seq foundation model is a judgement, not a keyword match. What
runs automatically is the *search*, not the decision.

Each week `pipeline/discover.py` scans bioRxiv and arXiv for a handful of
phrases (`single-cell foundation model`, `cell language model`, and so on,
matched after lowercasing and folding hyphens so "single-cell" and "single
cell" are one term). Anything that matches lands in
`pipeline/discovery_queue.json` with a status of `new`. Nothing is ever added
to the registry automatically.

Reviewing a row means setting its status:

| status | meaning |
| --- | --- |
| `new` | not yet reviewed — what the scan writes |
| `dismissed` | not an scFM; stop surfacing it |
| `added` | promoted into `registry.json` |

Dismissed rows stay in the file. That is the point of committing the queue
rather than caching it: `cache/` is gitignored and rebuilt on demand, so a
dismissal kept there would evaporate and the same rejects would reappear every
week. The queue sits next to `registry.json` because it is the same kind of
file — one a human maintains.

Three details that the two APIs force:

- **bioRxiv has no term search.** Its details endpoint pages a date interval
  thirty records at a time, about 1,700 preprints a week, and the filtering
  happens locally. So the scan is incremental: `cache/discovery.json` records
  the date already paged and the next run starts there. It also runs a few
  days of overlap, because preprints post later than the date they carry.
- **The window is scanned in chunks, and the watermark advances per chunk.**
  A page costs roughly six seconds, so a run works to a page budget. When the
  budget runs out mid-window the ground already covered is still recorded and
  the next run resumes from it. Advancing only on a fully clean sweep would
  mean a capped run re-reads the same opening pages every week and never
  reaches recent days.
- **Deduplication is deliberately one-sided.** A DOI already in the registry
  drops the candidate. A registry *name* appearing in a title only annotates
  it, because the names that would trip false matches are exactly the ordinary
  words — STATE, UCE — and silently hiding "cell state transitions after
  perturbation" to save one glance is the wrong trade for a tool whose job is
  not missing things.

Discovery runs last in the pipeline and its failure is not fatal. It feeds no
score and no page, so a bioRxiv outage should not strand a week of real
citation data uncommitted.

---

Data: [OpenAlex](https://openalex.org/) ·
[GitHub API](https://docs.github.com/rest) ·
[Hugging Face Hub](https://huggingface.co/docs/hub/api).
Citation counts measure attention, not quality.
