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
    "build_data.py",      # score, snapshot history, write data/*.json
]

for step in STEPS:
    print("\n=== {} ===".format(step), flush=True)
    result = subprocess.run([sys.executable, os.path.join(HERE, step)])
    if result.returncode != 0:
        sys.exit("{} failed with exit code {}".format(step, result.returncode))
print("\nPipeline complete.")
