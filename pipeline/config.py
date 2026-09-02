"""Shared configuration for the single-cell foundation model tracker pipeline."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "cache")
DATA_DIR = os.path.join(ROOT, "data")

# Curated model registry -- the one file edited by hand.
REGISTRY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.json")

# OpenAlex: citations, yearly counts, and the works that cite each paper.
# A mailto puts us in the polite pool (faster, more reliable).
OPENALEX_BASE = "https://api.openalex.org"
OPENALEX_MAILTO = os.environ.get("OPENALEX_MAILTO", "allysons703@gmail.com")
OPENALEX_DELAY = 0.3
OPENALEX_PER_PAGE = 200

# GitHub repo stats. GITHUB_TOKEN is supplied automatically inside Actions;
# without it the API allows 60 requests/hour, which is still enough locally.
GITHUB_API = "https://api.github.com"
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_DELAY = 0.2

# Hugging Face weights + download counts.
HF_API = "https://huggingface.co/api"
HF_DELAY = 0.2

# Runnability: PyPI packaging, pinned environments, tagged releases, notebooks
# and recent issue activity. Read from the GitHub API plus PyPI's JSON endpoint.
PYPI_API = "https://pypi.org/pypi"

# Discovery scan for new candidate models.
BIORXIV_API = "https://api.biorxiv.org/details/biorxiv"
ARXIV_API = "http://export.arxiv.org/api/query"
DISCOVERY_TERMS = [
    "single-cell foundation model",
    "single cell foundation model",
    "foundation model for single-cell",
    "single-cell transformer",
    "cell language model",
    "pretrained single-cell",
]
DISCOVERY_WINDOW_DAYS = 30

# Scoring. Weights are the defaults; the site's sliders re-weight client-side.
SCORE_WEIGHTS = {
    "attention": 0.35,   # log-scaled total citations
    "momentum": 0.25,    # citations gained recently
    "usage": 0.20,       # Hugging Face downloads + GitHub stars
    "openness": 0.10,    # open weights + permissive license + active upkeep
    "runnable": 0.10,    # packaged, pinned, released, documented, answered
}
# Runnability was carved out of openness rather than taken from the citation
# weights: both answer "can I use this", so the practical-usability family
# keeps the 0.20 it always had, and attention/momentum/usage are untouched.

# Signals inside the runnability component. A model is scored on the signals
# that could actually be observed for it -- a repo whose tree call failed is
# not credited with having no notebooks -- so these are renormalized per model
# by the weight of what was seen.
RUNNABLE_WEIGHTS = {
    "installable": 0.25,   # a PyPI package that links back to the repo
    "env": 0.20,           # requirements / environment / pyproject / Dockerfile
    "release": 0.15,       # a tagged release to pin
    "tutorials": 0.15,     # notebooks in the repo
    "responsive": 0.25,    # an issue closed in the trailing 90 days
}
TUTORIALS_FULL_CREDIT = 3   # notebooks needed for full marks on that signal
# Momentum window. Counted from the publication dates carried on the citing
# records themselves, not from snapshot arithmetic, so it is exact on the first
# run and retroactive for every model rather than waiting on history to deepen.
MOMENTUM_WINDOW_DAYS = 365
STALE_DAYS = 90          # no commits in this long => repo is "quiet"
# The full citing list for every model ships in data/citations/<id>.json and is
# fetched only when a model page is opened. data/citations.json is the index the
# leaderboard and the cross-model feed read on load, capped per model so the
# first paint does not carry scGPT's 1,300 rows.
CITING_PER_MODEL = 40    # citing articles kept in the upfront index

# Files
RESOLVED_FILE = os.path.join(CACHE_DIR, "resolved.json")
RUNNABLE_FILE = os.path.join(CACHE_DIR, "runnable.json")
OPENALEX_FILE = os.path.join(CACHE_DIR, "openalex.json")
GITHUB_FILE = os.path.join(CACHE_DIR, "github.json")
HF_FILE = os.path.join(CACHE_DIR, "huggingface.json")
CITING_CACHE_FILE = os.path.join(CACHE_DIR, "citing_cache.json")
DISCOVERY_FILE = os.path.join(CACHE_DIR, "discovery.json")

# data/history.json is append-only and lives in the repo, not the cache --
# weekly snapshots are the only way deltas and momentum can be computed.
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

# Week-over-week changelog and the Atom feed built from it. Both are committed
# output: the feed has to be a real file at a stable URL for a reader to poll.
CHANGELOG_FILE = os.path.join(DATA_DIR, "changelog.json")
FEED_FILE = os.path.join(ROOT, "feed.xml")
SITE_URL = "https://eastmanmd.github.io/scFM-tracker/"
SITE_DOMAIN = "eastmanmd.github.io"        # for stable tag: URIs in the feed
CHANGELOG_WEEKS = 52     # entries kept in data/changelog.json
FEED_ENTRIES = 20        # weeks published in feed.xml
CHANGELOG_MAX_PAPERS = 12   # new evaluations listed before the entry says "and N more"

# A model whose score is unchanged can still swap places with a neighbour it is
# a tenth of a point away from, week after week. Reporting that as news would
# bury the weeks something actually happened, so a rank move has to clear both
# thresholds to become an event.
RANK_MOVE_MIN = 2        # places
SCORE_MOVE_MIN = 0.5     # points
CITATION_MILESTONES = (100, 250, 500, 1000, 2500, 5000, 10000)

# One file per model, holding every citing article rather than the index's top N.
CITING_DIR = os.path.join(DATA_DIR, "citations")
