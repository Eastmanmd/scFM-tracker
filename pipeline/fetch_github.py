"""Repo stats: stars, forks, license, and how recently anyone touched it.

Last-commit date is the point of this step. Citations measure attention paid to
a model; commit recency measures whether it is still maintained. Models that
score high on one and low on the other are the interesting rows.
"""
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config


def headers():
    head = {"Accept": "application/vnd.github+json"}
    if config.GITHUB_TOKEN:
        head["Authorization"] = "Bearer {}".format(config.GITHUB_TOKEN)
    return head


def get(url, attempts=4):
    delay = 2.0
    for attempt in range(attempts):
        resp = requests.get(url, headers=headers(), timeout=30)
        if resp.status_code == 200:
            return resp.json(), 200
        if resp.status_code == 404:
            return None, 404
        if attempt < attempts - 1 and resp.status_code in (403, 429, 500, 502, 503):
            time.sleep(delay)
            delay *= 2
            continue
        return None, resp.status_code
    return None, 0


def main():
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)

    out = {}
    failures = []
    for model in registry["models"]:
        repo_slug = model.get("github")
        if not repo_slug:
            continue
        repo, status = get("{}/repos/{}".format(config.GITHUB_API, repo_slug))
        time.sleep(config.GITHUB_DELAY)
        if repo is None:
            failures.append((model["id"], repo_slug, status))
            print("{:<18} FAILED http {}".format(model["id"], status))
            continue

        out[model["id"]] = {
            "repo": repo["full_name"],
            "url": repo["html_url"],
            "stars": repo["stargazers_count"],
            "forks": repo["forks_count"],
            "open_issues": repo["open_issues_count"],
            "pushed_at": repo["pushed_at"],
            "created_at": repo["created_at"],
            "archived": repo["archived"],
            "license": (repo.get("license") or {}).get("spdx_id"),
        }
        print("{:<18} {:>5} stars  last push {}  {}".format(
            model["id"], repo["stargazers_count"], repo["pushed_at"][:10],
            "ARCHIVED" if repo["archived"] else ""))

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)

    # Merge over the previous snapshot so a transient API failure leaves the
    # last known-good numbers in place instead of blanking a column.
    if os.path.exists(config.GITHUB_FILE):
        with open(config.GITHUB_FILE) as fh:
            previous = json.load(fh)
        for mid, old in previous.items():
            if mid not in out:
                old["stale"] = True
                out[mid] = old

    with open(config.GITHUB_FILE, "w") as fh:
        json.dump(out, fh, indent=2)
    if failures:
        print("\n{} repo(s) failed; kept previous values where available.".format(
            len(failures)))
    print("Wrote {}".format(config.GITHUB_FILE))


if __name__ == "__main__":
    main()
