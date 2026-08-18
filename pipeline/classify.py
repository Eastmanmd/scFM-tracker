"""Label each citing paper on two independent axes.

  use     what the citing paper does with the model
          benchmark / extension / application / review
  domain  what kind of work the citing paper is
          method / biology / offtopic / unclear

The axes are deliberately orthogonal. "application" was doing double duty
before: 407 of 513 citing papers landed there, mixing new ML tools (PerturbLDM,
Concord, scMaize) with actual biology (spatial transcriptomics of psoriasis).
Splitting the field of the citing work onto its own axis is what makes the
biology share -- the number worth putting on the page -- computable at all.

Both classifiers read title + abstract + OpenAlex topics. Abstracts cover ~73%
of citing works and carry most of the signal: "we present a framework" versus
"we profiled 40,000 cells from 12 patients" is a distinction titles frequently
drop.

CAVEAT worth repeating wherever these numbers surface: this classifies the
citing *paper*, not the citation. A biology paper that name-drops a model in
its introduction and never runs it still counts as a biology citation. Only
full text could separate use from mention, and OpenAlex does not carry it.
"""
import re

# ---------------------------------------------------------------- use axis

BENCHMARK_TERMS = ("benchmark", "evaluat", "comparison", "comparative",
                   "assessing", "assessment", "limits of", "do ", "critical")
REVIEW_TERMS = ("review", "survey", "perspective", "opportunities", "landscape")
EXTENSION_TERMS = ("fine-tun", "finetun", "building on", "extend", "adapt",
                   "improv", "distill")

# ------------------------------------------------------------- domain axis
#
# Two tiers, because the first attempt conflated them and abstained on a
# quarter of the corpus. CONTRIBUTION phrases say what the paper itself did
# and are close to decisive. CONTEXT phrases only say what field it sits in --
# a method paper applied to tumours talks about tumours throughout, so disease
# and tissue vocabulary cannot be allowed to outvote "we present a framework".
# Context is capped (CONTEXT_CAP) so it can break a tie but never win one.

METHOD_CONTRIBUTION = (
    (4, r"\bwe (present|propose|introduce|develop|design|build|implement)\b"),
    (4, r"\b(outperform\w*|state[- ]of[- ]the[- ]art|against baselines?|"
        r"baseline (method|model)s?)\b"),
    (3, r"\b(novel|new|unified|general[- ]purpose)\b[^.]{0,40}"
        r"\b(method|framework|algorithm|architecture|model|approach|toolkit|"
        r"pipeline)\b"),
    (3, r"\b(pre[- ]?train|fine[- ]?tun|zero[- ]shot|few[- ]shot|"
        r"transfer learning|self[- ]supervised|parameter[- ]efficient)\w*"),
    (3, r"\b(foundation model|language model|virtual cell|digital twin|"
        r"deep learning model|neural network|transformer|autoencoder|"
        r"diffusion model|graph neural|mixture[- ]of[- ]experts)\w*"),
    (3, r"\b(benchmark\w*|evaluat\w+)\b[^.]{0,40}\b(model|method|tool|"
        r"framework|embedding)s?\b"),
    # Single-cell analysis tasks. Naming one as the object of the work is a
    # methods paper almost without exception.
    (3, r"\b(cell type annotation|batch (effect|correction)|data integration|"
        r"imputation|deconvolution|dimensionality reduction|"
        r"trajectory inference|perturbation prediction|embedding space)\b"),
    (2, r"\b(interpretab\w+|scalab\w+|generaliz\w+|robustness)\b"),
    (2, r"\b(downstream task|ablation|hyperparameter|training data|"
        r"loss function|f1[- ]score|auroc|held[- ]out)\b"),
)

# "ToolName: what it does" and "... with ToolName" -- the dominant title form
# for a computational contribution in this literature.
TOOL_NAME_TITLE = re.compile(
    r"^[A-Za-z][A-Za-z0-9._+-]{2,24}\s*[:\u2013-]\s+\w|"
    r"\b(with|using|via)\s+[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*\b")

BIOLOGY_CONTRIBUTION = (
    (4, r"\bwe (profiled|sequenced|collected|isolated|generated|recruited|"
        r"enrolled|examined|measured)\b[^.]{0,60}\b(cells|samples|patients|"
        r"biopsies|tissue|donors|tumou?rs|mice|participants)\b"),
    (4, r"\b(patients?|cohort|biopsy|biopsies|donors?|clinical trial|"
        r"participants|autops\w+)\b"),
    (4, r"\b(mice|mouse model|in vivo|in vitro|knockout|knockdown|"
        r"transgenic|xenograft|organoid|cell line[s]? were)\b"),
    # Title verbs that announce a finding rather than a tool.
    # A finding verb in the title outranks whatever instrument produced the
    # finding: "Foundation model reveals the organization of transcription" is
    # a biology paper that happens to have used a model.
    (4, r"^[^.]{0,90}\b(reveals?|uncovers?|identifies|demonstrates?|"
        r"establishes|defines|delineates?|charts?)\b"),
    (3, r"^[^.]{0,60}\b(atlas|landscape|map(ping)?|characteri[sz]ation|"
        r"census|compendium)\s+(of|across|the|in)\b"),
    (3, r"\b(differentially expressed|marker genes?|cell fate|lineage "
        r"tracing|pathogenesis|disease progression|drug resistance|"
        r"tumou?r microenvironment|immune infiltration)\b"),
    (2, r"\b(we (found|observed|show)|our (results|findings) (show|reveal|"
        r"suggest|indicate))\b"),
)

METHOD_CONTEXT = (
    (1, r"\b(computational|in silico|bioinformatic\w*|machine learning|"
        r"artificial intelligence|software|open[- ]source|gpu)\b"),
    (1, r"\b(accuracy|performance|prediction task)\b"),
)

BIOLOGY_CONTEXT = (
    (1, r"\b(carcinoma|melanoma|leukemi\w+|leukaemi\w+|glioma|alzheimer|"
        r"parkinson|diabetes|fibrosis|psoriasis|lupus|asthma|covid|"
        r"sars-cov-2|sepsis|arthritis|metastasis)\b"),
    (1, r"\b(tissue|liver|kidney|lung|brain|heart|retina|intestin\w*|"
        r"pancrea\w+|immune|macrophage|neuron|embryo\w*)\b"),
)

# The field itself. Absence of every one of these across title, abstract, and
# topics is what marks a passing citation -- papers on polymer thermocells or
# education that cite a foundation model as an example of the genre.
FIELD_TERMS = re.compile(
    r"\b(single[- ]cell|scrna|sc[- ]?rna[- ]?seq|transcriptom|genomic|"
    r"multi[- ]?omic|omics|gene expression|cell type|spatial transcriptom|"
    r"perturbation|atac|proteom|biolog|cellular|rna|gene)\w*", re.I)

CONTEXT_CAP = 2    # context can break a tie, never win one
MIN_SCORE = 3      # below this the evidence is too thin to call
MIN_MARGIN = 2     # winner must beat the runner-up by this much


def abstract_text(inverted, limit=2500):
    """Rebuild readable text from OpenAlex's inverted index.

    OpenAlex ships abstracts as {word: [positions]} for copyright reasons.
    Truncated because only the opening few sentences -- where a paper states
    what it did -- carry classification signal.
    """
    if not inverted:
        return ""
    positions = {}
    for word, idxs in inverted.items():
        for i in idxs:
            positions[i] = word
    return " ".join(positions[i] for i in sorted(positions))[:limit]


def _score(text, signals):
    total = 0
    for weight, pattern in signals:
        if re.search(pattern, text, re.I):
            total += weight
    return total


def classify_use(work, text=""):
    """What the citing paper does with the model."""
    title = (work.get("title") or "").lower()
    if work.get("type") == "review" or any(t in title for t in REVIEW_TERMS):
        return "review"
    if any(t in title for t in BENCHMARK_TERMS):
        return "benchmark"
    if any(t in title for t in EXTENSION_TERMS):
        return "extension"
    return "application"


def classify_domain(work, text=None):
    """What kind of work the citing paper is.

    Returns (label, confidence) where confidence is the winning margin.
    Surfaced rather than swallowed so a weak call can be shown as weak instead
    of being laundered into a clean-looking percentage.
    """
    if text is None:
        text = build_text(work)
    title = work.get("title") or ""
    topics = " ".join(topic_names(work))

    # Off-topic first: no single-cell or biology vocabulary anywhere at all.
    if not FIELD_TERMS.search("{} {}".format(text, topics)):
        return "offtopic", 3

    method = _score(text, METHOD_CONTRIBUTION)
    biology = _score(text, BIOLOGY_CONTRIBUTION)

    # "scGPT: a foundation model for..." -- the tool-name title form is worth
    # as much as an explicit "we present", and catches the many method papers
    # whose abstract never uses the first person.
    if TOOL_NAME_TITLE.search(title):
        method += 3

    method += min(_score(text, METHOD_CONTEXT), CONTEXT_CAP)
    biology += min(_score(text, BIOLOGY_CONTEXT), CONTEXT_CAP)

    # Topic names are the weakest input available. They describe the field,
    # not the contribution -- 45% of scGPT's citers carry "Single-cell and
    # spatial transcriptomics" whether they are tools or biology -- so they
    # move the score by one at most.
    lowered = topics.lower()
    if any(t in lowered for t in ("machine learning", "artificial intelligence",
                                  "deep learning", "topic modeling",
                                  "computational drug", "bioinformatics")):
        method += 1
    if any(t in lowered for t in ("cancer", "disease", "immun", "clinical",
                                  "medicine", "neuro")):
        biology += 1

    top, runner = max(method, biology), min(method, biology)
    if top < MIN_SCORE or (top - runner) < MIN_MARGIN:
        return "unclear", top - runner
    return ("method" if method > biology else "biology"), top - runner


def build_text(work):
    """Title plus abstract, the input both classifiers read."""
    title = work.get("title") or ""
    abstract = work.get("abstract")
    if abstract is None:
        abstract = abstract_text(work.get("abstract_inverted_index"))
    return "{}. {}".format(title, abstract).strip()


def topic_names(work):
    """Topic display names, from either a raw OpenAlex work or a slim record.

    Slim records cache the flattened list under "topic_names" so re-labelling
    from cache sees exactly the inputs the live fetch saw. Without that the
    validation harness would score the classifier on weaker evidence than
    production uses, and report a number that is not the one you get.
    """
    if work.get("topic_names") is not None:
        return work["topic_names"]
    names = []
    primary = work.get("primary_topic") or {}
    for key in ("display_name",):
        if primary.get(key):
            names.append(primary[key])
    for level in ("subfield", "field"):
        node = primary.get(level) or {}
        if node.get("display_name"):
            names.append(node["display_name"])
    for topic in work.get("topics") or []:
        if topic.get("display_name"):
            names.append(topic["display_name"])
    return names


def classify(work):
    """Both axes at once. Returns (use, domain, confidence, has_abstract)."""
    text = build_text(work)
    has_abstract = len(text) > (len(work.get("title") or "") + 5)
    domain, confidence = classify_domain(work, text)
    return classify_use(work, text), domain, confidence, has_abstract
