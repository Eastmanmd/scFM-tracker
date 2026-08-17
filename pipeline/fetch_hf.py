"""Hugging Face downloads and likes -- the closest thing to a usage metric.

Citations tell you a model got written about. Downloads tell you people
actually pulled the weights. A model can be strong on one and weak on the
other, and the gap is worth showing.
"""
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


def get(url, attempts=4):
    delay = 2.0
    for attempt in range(attempts):
        resp = requests.get(url, timeout=30)
        if resp.status_code == 200:
            return resp.json(), 200
        if resp.status_code == 404:
            return None, 404
        if attempt < attempts - 1 and resp.status_code in (429, 500, 502, 503):
            time.sleep(delay)
            delay *= 2
            continue
        return None, resp.status_code
    return None, 0


def main():
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)

    out = {}
    for model in registry["models"]:
        repos = model.get("hf") or []
        if not repos:
            continue
        entries = []
        for hf_id in repos:
            info, status = get("{}/models/{}".format(config.HF_API, quote(hf_id)))
            time.sleep(config.HF_DELAY)
            if info is None:
                print("{:<18} {} FAILED http {}".format(model["id"], hf_id, status))
                continue
            entries.append({
                "id": hf_id,
                "url": "https://huggingface.co/{}".format(hf_id),
                "downloads": info.get("downloads") or 0,
                "downloads_all_time": info.get("downloadsAllTime"),
                "likes": info.get("likes") or 0,
                "last_modified": info.get("lastModified"),
                "license": ((info.get("cardData") or {}).get("license")),
            })
        if entries:
            out[model["id"]] = {
                "repos": entries,
                "downloads": sum(e["downloads"] for e in entries),
                "likes": sum(e["likes"] for e in entries),
            }
            print("{:<18} {:>7} downloads/30d  {:>4} likes  ({} repo)".format(
                model["id"], out[model["id"]]["downloads"],
                out[model["id"]]["likes"], len(entries)))

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)
    with open(config.HF_FILE, "w") as fh:
        json.dump(out, fh, indent=2)
    print("Wrote {}".format(config.HF_FILE))


if __name__ == "__main__":
    main()
