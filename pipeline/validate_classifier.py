"""Score the domain classifier against pipeline/labels.json.

Run it after any change to classify.py. Accuracy alone hides the failure that
matters here -- biology is the minority class, so a classifier that answered
"method" for everything would still look respectable. Per-class recall and the
confusion matrix are what to read.

  python3 pipeline/validate_classifier.py          # score current labels
  python3 pipeline/validate_classifier.py --errors # also list every miss

Reads records from cache/citing_cache.json, so run the fetch at least once
first. Nothing here calls the network.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify
import config

LABELS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "labels.json")
CLASSES = ("method", "biology", "offtopic", "unclear")


def load_corpus():
    """Every cached citing record, deduped by work id."""
    if not os.path.exists(config.CITING_CACHE_FILE):
        sys.exit("no {} -- run pipeline/fetch_openalex.py first".format(
            config.CITING_CACHE_FILE))
    with open(config.CITING_CACHE_FILE) as fh:
        cache = json.load(fh)
    records = {}
    for entry in cache.values():
        for rec in entry.get("records", []):
            records[rec["id"]] = rec
    return records


def main():
    show_errors = "--errors" in sys.argv
    with open(LABELS_FILE) as fh:
        truth = json.load(fh)["labels"]
    corpus = load_corpus()

    missing = [wid for wid in truth if wid not in corpus]
    pairs = []
    for wid, want in truth.items():
        rec = corpus.get(wid)
        if rec is None:
            continue
        got, _ = classify.classify_domain(rec)
        pairs.append((wid, rec, want, got))

    if not pairs:
        sys.exit("no labelled records found in the cache")

    correct = sum(1 for _, _, want, got in pairs if want == got)
    # "unclear" is an abstention, not a wrong answer. Both numbers matter: a
    # classifier can buy accuracy by abstaining on everything hard, so coverage
    # is reported alongside.
    decided = [p for p in pairs if p[3] != "unclear"]
    decided_correct = sum(1 for _, _, want, got in decided if want == got)

    print("labelled {} of {} ({} not in cache)".format(
        len(pairs), len(truth), len(missing)))
    print("overall accuracy   {}/{}  {:.0%}".format(
        correct, len(pairs), correct / float(len(pairs))))
    print("coverage (decided) {}/{}  {:.0%}".format(
        len(decided), len(pairs), len(decided) / float(len(pairs))))
    if decided:
        print("accuracy when decided {}/{}  {:.0%}".format(
            decided_correct, len(decided),
            decided_correct / float(len(decided))))

    print("\nper class:")
    print("  {:<10}{:>7}{:>9}{:>9}".format("truth", "n", "recall", "abstain"))
    for cls in CLASSES:
        rows = [p for p in pairs if p[2] == cls]
        if not rows:
            continue
        hit = sum(1 for _, _, want, got in rows if got == want)
        abstain = sum(1 for _, _, _, got in rows if got == "unclear")
        print("  {:<10}{:>7}{:>8.0%}{:>9.0%}".format(
            cls, len(rows), hit / float(len(rows)),
            abstain / float(len(rows))))

    print("\nconfusion (rows = truth, cols = predicted):")
    print("  {:<10}{}".format("", "".join("{:>10}".format(c) for c in CLASSES)))
    for cls in CLASSES:
        rows = [p for p in pairs if p[2] == cls]
        if not rows:
            continue
        cells = "".join("{:>10}".format(
            sum(1 for _, _, _, got in rows if got == c)) for c in CLASSES)
        print("  {:<10}{}".format(cls, cells))

    if show_errors:
        print("\nmisses:")
        for wid, rec, want, got in sorted(pairs, key=lambda p: (p[2], p[3])):
            if want == got:
                continue
            print("  want {:<9} got {:<9} {} {}".format(
                want, got, "[no abstract]" if not rec.get("has_abstract")
                else "", (rec.get("title") or "")[:90]))


if __name__ == "__main__":
    main()
