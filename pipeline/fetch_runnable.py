"""Can you actually install and run this model today?

Citations say the field noticed a model, stars say people bookmarked it, and
the last-commit date says someone still touches the code. None of them answer
the question anyone asks before spending an afternoon on one of these: does it
install, is there a version to pin, is there a worked example, and if it breaks
will anyone answer.

Five signals:

  installable  a PyPI package whose metadata points back at this model's repo
  env          requirements.txt / environment.yml / pyproject.toml / Dockerfile
  release      a tagged release (GitHub) or a tagged revision (Hugging Face)
  tutorials    notebooks shipped alongside the code
  responsive   an issue or discussion resolved in the last 90 days

Each one is read from GitHub *and* from Hugging Face, and the two are merged.
That matters more than it sounds: Geneformer ships no GitHub repository at all,
and reading only GitHub would have left it unmeasured -- which, under the
renormalizing scorer, quietly moved it to #1 for having nothing to fail at.
A model is now scored on the same five questions wherever its code lives, and
only a model published on neither host goes unmeasured.

Three GitHub calls per repo -- a recursive tree, the latest release, recently
closed issues -- which keeps a full run inside the 60/hour an unauthenticated
local run gets. The Action supplies a token and has 5,000. Hugging Face adds
three unauthenticated calls per weights repo.

A signal is stored as True, False, or absent. Absent means the call did not
succeed, and build_data.py scores a model on what it could observe rather than
reading a failed request as a missing feature -- the same rule upkeep_score
follows, and it exists because the opposite behaviour, a throttled request
quietly reading as "no docs, no releases", is how a ranking goes wrong without
anyone noticing.
"""
import datetime
import json
import os
import sys
import time
try:
    from urllib.parse import quote
except ImportError:                      # pragma: no cover
    from urllib import quote

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

ENV_FILES = ("requirements.txt", "environment.yml", "environment.yaml",
             "pyproject.toml", "setup.py", "setup.cfg", "conda.yaml",
             "poetry.lock", "pixi.toml")
DOCKER_FILES = ("dockerfile", "docker-compose.yml", "docker-compose.yaml")

# The keys every source reports on, so GitHub and Hugging Face results can be
# merged without either one knowing about the other.
SIGNAL_KEYS = ("env", "release", "tutorials", "responsive")


def gh_headers():
    head = {"Accept": "application/vnd.github+json"}
    if config.GITHUB_TOKEN:
        head["Authorization"] = "Bearer {}".format(config.GITHUB_TOKEN)
    return head


def get(url, headers=None, attempts=3):
    """Returns (payload, status). A 404/409/410 is a real answer about the
    resource; anything else that fails leaves the signal unknown."""
    delay = 2.0
    for attempt in range(attempts):
        try:
            resp = requests.get(url, headers=headers or {}, timeout=45)
        except requests.RequestException:
            return None, 0
        if resp.status_code == 200:
            return resp.json(), 200
        if resp.status_code in (404, 409, 410):
            return None, resp.status_code
        if attempt < attempts - 1 and resp.status_code in (403, 429, 500, 502, 503):
            time.sleep(delay)
            delay *= 2
            continue
        return None, resp.status_code
    return None, 0


def scan_paths(paths):
    """Env files, container files and notebook count from a list of file paths.

    Shared by both hosts: a repository is a list of filenames either way.
    """
    lower = [p.lower() for p in paths]
    roots = [p for p in lower if "/" not in p]
    env = sorted(set(name for name in ENV_FILES if name in roots))
    docker = any(name in roots for name in DOCKER_FILES) or \
        any(p.endswith("dockerfile") for p in lower)
    return env, docker, sum(1 for p in lower if p.endswith(".ipynb"))


# ---------------------------------------------------------------- GitHub

def github_signals(slug, since):
    out = {"env": None, "release": None, "tutorials": None, "responsive": None}
    detail = {}
    statuses = []

    # HEAD resolves to the default branch, so this needs no extra call to learn
    # what that branch is called.
    tree, status = get("{}/repos/{}/git/trees/HEAD?recursive=1".format(
        config.GITHUB_API, slug), gh_headers())
    statuses.append(status)
    if tree is not None:
        paths = [i["path"] for i in tree.get("tree", []) if i.get("type") == "blob"]
        env, docker, nb = scan_paths(paths)
        out["env"] = bool(env or docker)
        out["tutorials"] = nb
        detail.update({"env_files": env, "dockerfile": docker, "notebooks": nb,
                       "tree_truncated": bool(tree.get("truncated"))})
    time.sleep(config.GITHUB_DELAY)

    rel, status = get("{}/repos/{}/releases/latest".format(config.GITHUB_API, slug),
                      gh_headers())
    statuses.append(status)
    if status == 404:
        out["release"] = False           # a real answer: no release exists
    elif rel is not None:
        out["release"] = True
        detail["release"] = rel.get("tag_name")
    time.sleep(config.GITHUB_DELAY)

    # An open-issue count says how big a backlog is; it says nothing about
    # whether anyone is still reading. A closed issue is evidence someone is.
    issues, status = get(
        "{}/repos/{}/issues?state=closed&since={}&per_page=100".format(
            config.GITHUB_API, slug, since), gh_headers())
    statuses.append(status)
    if status == 410:
        detail["issues_enabled"] = False  # switched off: not an unanswered repo
    elif issues is not None:
        # The issues endpoint returns pull requests too; a merged PR is a fine
        # sign of life, but "closed issue" should mean what it says.
        closed = [i for i in issues if "pull_request" not in i
                  and (i.get("closed_at") or "") >= since]
        out["responsive"] = len(closed) > 0
        detail.update({"issues_enabled": True, "closed_issues_90d": len(closed)})
    time.sleep(config.GITHUB_DELAY)

    return out, detail, statuses


# ---------------------------------------------------------- Hugging Face

def hf_signals(hf_ids, since):
    out = {"env": None, "release": None, "tutorials": None, "responsive": None}
    detail = {}
    statuses = []
    for hf_id in hf_ids:
        base = "{}/models/{}".format(config.HF_API, quote(hf_id))

        info, status = get(base)
        statuses.append(status)
        if info is not None:
            paths = [s.get("rfilename", "") for s in info.get("siblings", [])]
            env, docker, nb = scan_paths(paths)
            out["env"] = bool(env or docker) or bool(out["env"])
            out["tutorials"] = max(nb, out["tutorials"] or 0)
            detail["hf_env_files"] = sorted(set(detail.get("hf_env_files", []) + env))
            detail["hf_notebooks"] = max(nb, detail.get("hf_notebooks", 0))
        time.sleep(config.HF_DELAY)

        refs, status = get(base + "/refs")
        statuses.append(status)
        if refs is not None:
            tags = [t.get("name") for t in refs.get("tags", []) if t.get("name")]
            out["release"] = bool(tags) or bool(out["release"])
            if tags:
                detail["hf_tag"] = tags[-1]
        time.sleep(config.HF_DELAY)

        # Hugging Face reports when a thread was opened, not when it closed, so
        # this asks the stricter question: was a thread opened *and* resolved
        # inside the window. A maintainer clearing a year-old backlog does not
        # register, which understates rather than flatters.
        disc, status = get(base + "/discussions")
        statuses.append(status)
        if disc is not None:
            recent = [d for d in disc.get("discussions", [])
                      if (d.get("createdAt") or "") >= since
                      and d.get("status") in ("closed", "merged")]
            out["responsive"] = bool(recent) or bool(out["responsive"])
            detail["hf_resolved_90d"] = max(len(recent),
                                            detail.get("hf_resolved_90d", 0))
        time.sleep(config.HF_DELAY)

    return out, detail, statuses


# ------------------------------------------------------------------ PyPI

def pypi_signal(model, slug, hf_ids):
    """A PyPI package, accepted only if its metadata points back at this model.

    Guessing by name alone is how `uce` gets matched to an unrelated package
    and a model is credited with someone else's release -- PyPI's `uce`,
    `scfoundation` and `scbert` all belong to different projects, and all three
    are correctly rejected here. Requiring the package to name the model's own
    repository makes a false positive very unlikely and a false negative -- a
    real package that never links its source -- merely possible, which is the
    right way round for a number that feeds a ranking. The two known false
    negatives are named in registry.json instead.
    """
    declared = model.get("pypi")
    if declared:
        data, status = get("{}/{}/json".format(config.PYPI_API, declared))
        if status not in (200, 404):
            return None, {}              # unknown, not absent
        if data is None:
            return False, {}
        info = data.get("info", {})
        return True, {"pypi": info.get("name"), "pypi_version": info.get("version"),
                      "pypi_source": "registry"}

    targets = [t.lower() for t in
               ([slug] if slug else []) + ["huggingface.co/" + h for h in hf_ids]]
    if not targets:
        return None, {}                  # nothing to verify against

    repo_name = (slug or hf_ids[0]).split("/")[-1]
    plain = "".join(ch for ch in model["name"].lower() if ch.isalnum())
    seen, unknown = set(), False
    for name in (repo_name, model["id"], plain, repo_name.replace("_", "-")):
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        data, status = get("{}/{}/json".format(config.PYPI_API, name))
        if status not in (200, 404):
            unknown = True
            continue
        if data is None:
            continue
        info = data.get("info", {})
        urls = [info.get("home_page") or "", info.get("package_url") or ""]
        urls += list((info.get("project_urls") or {}).values())
        blob = " ".join(u.lower() for u in urls if u)
        if any(t in blob for t in targets):
            return True, {"pypi": info.get("name"),
                          "pypi_version": info.get("version")}
    return (None, {}) if unknown else (False, {})


def merge(a, b):
    """Best answer from either host. Absent on both stays absent."""
    out = {}
    for key in SIGNAL_KEYS:
        va, vb = a.get(key), b.get(key)
        if va is None and vb is None:
            out[key] = None
        elif va is None:
            out[key] = vb
        elif vb is None:
            out[key] = va
        elif key == "tutorials":
            out[key] = max(va, vb)
        else:
            out[key] = bool(va) or bool(vb)
    return out


def main():
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)

    today = datetime.date.today()
    since = (today - datetime.timedelta(
        days=config.STALE_DAYS)).isoformat() + "T00:00:00Z"

    out = {}
    incomplete = []
    for model in registry["models"]:
        slug = model.get("github")
        hf_ids = model.get("hf") or []
        if not slug and not hf_ids:
            continue                     # nothing published anywhere to inspect

        gh_sig, gh_detail, gh_status = ({}, {}, [])
        if slug:
            gh_sig, gh_detail, gh_status = github_signals(slug, since)
        hf_sig, hf_detail, hf_status = ({}, {}, [])
        if hf_ids:
            hf_sig, hf_detail, hf_status = hf_signals(hf_ids, since)

        signals = merge(gh_sig, hf_sig)
        installable, pypi_detail = pypi_signal(model, slug, hf_ids)
        signals["installable"] = installable

        record = {"checked": today.isoformat(), "signals": signals,
                  "sources": [s for s, on in (("github", bool(slug)),
                                              ("huggingface", bool(hf_ids))) if on]}
        record.update(gh_detail)
        record.update(hf_detail)
        record.update(pypi_detail)
        if slug:
            record["repo"] = slug

        bad = [s for s in gh_status + hf_status if s not in (200, 404, 409, 410)]
        if bad:
            incomplete.append(model["id"])
        out[model["id"]] = record

        print("{:<18} {:<12} install {:<5} env {:<5} rel {:<5} nb {:<4} answered {}".format(
            model["id"], "+".join(record["sources"]),
            str(signals["installable"]), str(signals["env"]),
            str(signals["release"]), str(signals["tutorials"]),
            str(signals["responsive"])))

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)

    # Same rule as fetch_github: a run that could not reach a host keeps the
    # previous answer rather than replacing it with silence.
    if os.path.exists(config.RUNNABLE_FILE):
        with open(config.RUNNABLE_FILE) as fh:
            previous = json.load(fh)
        for mid, old in previous.items():
            if mid not in out:
                old["stale"] = True
                out[mid] = old
                continue
            old_signals = old.get("signals") or {}
            for key, value in out[mid]["signals"].items():
                if value is None and old_signals.get(key) is not None:
                    out[mid]["signals"][key] = old_signals[key]
                    out[mid].setdefault("carried", []).append(key)

    with open(config.RUNNABLE_FILE, "w") as fh:
        json.dump(out, fh, indent=2)
    if incomplete:
        print("\n{} model(s) had at least one call fail; kept previous values "
              "where available: {}".format(len(incomplete), ", ".join(incomplete)))
    print("Wrote {}".format(config.RUNNABLE_FILE))


if __name__ == "__main__":
    main()
