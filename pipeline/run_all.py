"""Run the full pipeline end to end (used by the weekly GitHub Action)."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

STEPS = [
    "resolve_ids.py",     # verify every DOI / repo / weights id still resolves
    "fetch_openalex.py",  # citations, yearly trend, citing articles
    "fetch_github.py",    # stars, forks, last commit
    "fetch_hf.py",        # weight downloads
    "fetch_runnable.py",  # packaging, releases, notebooks, issue response
    "build_data.py",      # score, snapshot history, write data/*.json
    "make_feed.py",       # publish data/changelog.json as feed.xml
]

# Discovery only suggests candidates for review -- it feeds no metric and no
# page. A bioRxiv outage should not fail the run and strand a week of real
# citation data uncommitted, so it runs last and its exit code is reported
# rather than fatal.
OPTIONAL_STEPS = [
    "discover.py",        # queue new candidate models in discovery_queue.json
]


def run(step):
    print("\n=== {} ===".format(step), flush=True)
    return subprocess.run([sys.executable, os.path.join(HERE, step)]).returncode


for step in STEPS:
    code = run(step)
    if code != 0:
        sys.exit("{} failed with exit code {}".format(step, code))

failed = []
for step in OPTIONAL_STEPS:
    if run(step) != 0:
        failed.append(step)
        print("{} failed -- continuing, it feeds no published metric".format(step))

print("\nPipeline complete.")
if failed:
    print("Optional step(s) did not complete: {}".format(", ".join(failed)))
