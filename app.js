/* Single-Cell Foundation Model Tracker — reads data/*.json, renders everything
   client-side. No build step, no dependencies. */

var DATA = {models: [], citations: {}, meta: {}, history: {snapshots: []}, h2h: null, changelog: null};

/* data/citations.json carries only the most recent few articles per model so the
   first paint stays small. A model's complete citing list lives in its own file
   and is pulled the first time its page is opened, then kept for the session.
   citingFull[id] is undefined until fetched, null while in flight, and false if
   the fetch failed -- so a failure falls back to the index instead of retrying
   on every re-render. */
var citingFull = {};
var CITING_PAGE = 100;   // rows revealed per "show more" click
var citingShown = CITING_PAGE;
var WEIGHT_KEYS = ["attention", "momentum", "usage", "openness", "runnable"];
/* The four keys a shared link used before runnability existed. Such a link is
   honoured with runnability at zero, so the ranking someone shared still ranks
   the way it did when they shared it. */
var LEGACY_WEIGHT_KEYS = ["attention", "momentum", "usage", "openness"];
var WEIGHT_LABELS = {
  attention: "Attention (citations)",
  momentum: "Momentum (recent gain)",
  usage: "Usage (downloads + stars)",
  openness: "Openness & upkeep",
  runnable: "Runnability (install & support)"
};
var weights = {attention: 0.35, momentum: 0.25, usage: 0.20, openness: 0.10,
               runnable: 0.10};
var sortKey = "score", sortDir = -1;
var filters = {};
var TASKS = ["annotation", "integration", "imputation", "perturbation", "grn", "spatial"];
var h2hPair = null;   // "modelA|modelB" while a matrix cell is selected
var logWeeks = 1;     // changelog weeks shown on the leaderboard card

/* ---------- helpers ---------- */
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c];
  });
}
function num(n) { return n == null ? "—" : Number(n).toLocaleString(); }
function compact(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}

/* Re-score client-side so the sliders are instant. Mirrors build_data.py:
   components are precomputed and normalized; only the weighting changes here. */
function rescore(model) {
  // Mirrors build_data.py: a component with no data for this model is dropped
  // and the remaining weights renormalized, rather than counted as a zero.
  var known = WEIGHT_KEYS.filter(function (k) { return model.components[k] != null; });
  var total = known.reduce(function (s, k) { return s + weights[k]; }, 0);
  if (!total) return 0;
  return known.reduce(function (s, k) {
    return s + model.components[k] * weights[k];
  }, 0) / total * 100;
}

function sparkline(counts, width, height) {
  var years = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
  if (!years.length) return "";
  var lo = Math.min.apply(null, years), hi = Math.max.apply(null, years);
  if (hi === lo) { hi = lo + 1; }
  var max = Math.max.apply(null, years.map(function (y) { return counts[y]; })) || 1;
  var pts = years.map(function (y) {
    var x = ((y - lo) / (hi - lo)) * (width - 2) + 1;
    var yy = height - 1 - (counts[y] / max) * (height - 3);
    return x.toFixed(1) + "," + yy.toFixed(1);
  });
  var last = pts[pts.length - 1].split(",");
  return '<svg class="spark" width="' + width + '" height="' + height + '" aria-hidden="true">' +
    '<polyline fill="none" stroke="var(--series-1)" stroke-width="1.4" points="' + pts.join(" ") + '"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2" fill="var(--series-1)"/></svg>' +
    '<span class="sub">' + lo + "–" + hi + "</span>";
}

/* GitHub reports an unrecognised licence file as NOASSERTION. That is not a
   licence name -- it means nobody can tell what the terms are, which is the
   thing a reader needs to know. */
function isUnclearLicense(license) {
  return !license || license === "NOASSERTION" || license === "unstated";
}
function licenseCell(license) {
  return isUnclearLicense(license)
    ? '<span class="lic-unclear">unclear</span>'
    : '<span class="sub">' + esc(license) + "</span>";
}

function deltaTag(value, unit) {
  if (value == null || value === 0) return "";
  var cls = value > 0 ? "delta-up" : "delta-down";
  return ' <span class="' + cls + '">' + (value > 0 ? "▲" : "▼") +
    Math.abs(value) + (unit || "") + "</span>";
}

/* ---------- theme toggle ----------
   With no stored choice the page follows the OS. The first click stores an
   explicit preference, which then wins in both directions. Charts read their
   colours from CSS custom properties, so nothing needs re-rendering. */

var THEME_KEY = "scfm-theme";
var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/>' +
  '<path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.3 6.3 4.7 4.7M19.3 19.3l-1.6-1.6' +
  'M17.7 6.3l1.6-1.6M4.7 19.3l1.6-1.6"/></svg>';
var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>';

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}
function systemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}
function activeTheme() {
  return document.documentElement.getAttribute("data-theme") || systemTheme();
}

function paintToggle() {
  var goingTo = activeTheme() === "dark" ? "light" : "dark";
  el("theme-icon").innerHTML = goingTo === "dark" ? MOON : SUN;
  el("theme-label").textContent = goingTo === "dark" ? "Dark" : "Light";
  el("theme-toggle").setAttribute("aria-label", "Switch to " + goingTo + " mode");
}

function initTheme() {
  paintToggle();
  el("theme-toggle").addEventListener("click", function () {
    var next = activeTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* not fatal */ }
    paintToggle();
  });
  // Keep the button honest if the OS flips while the user has no stored choice.
  // Only the label can go stale -- the colours themselves are pure CSS -- so
  // this is belt-and-braces: the media query event, plus a repaint whenever the
  // tab is shown again, since that event does not fire everywhere.
  var refresh = function () { if (!storedTheme()) paintToggle(); };
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", refresh);
    else if (mq.addListener) mq.addListener(refresh);
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
  window.addEventListener("pageshow", refresh);
}

/* ---------- KPI row ---------- */
function renderKpis() {
  var m = DATA.meta;
  var cards = [
    [m.models_tracked, "models tracked"],
    [num(m.total_citations), "citations across the field"],
    [m.actively_maintained + " / " + m.models_tracked, "updated in last 90 days"],
    [m.open_weights + " / " + m.models_tracked, "with open weights"],
    [m.history_depth, "weekly snapshots"]
  ];
  el("kpi-row").innerHTML = cards.map(function (c) {
    return '<div class="kpi"><b>' + c[0] + "</b><span>" + c[1] + "</span></div>";
  }).join("");
  el("provenance").textContent =
    "Updated " + m.updated + " · sources: " + (m.sources || []).join(", ") +
    " · momentum from " + m.momentum_basis;
}

/* ---------- leaderboard ---------- */
function activeModels() {
  return DATA.models.filter(function (mo) {
    if (filters.open && !mo.weights_open) return false;
    if (filters.active && mo.upkeep !== "active") return false;
    if (filters.surging && mo.velocity !== "surging") return false;
    if (filters.weights_hf && !mo.hf) return false;
    for (var i = 0; i < TASKS.length; i++) {
      if (filters["task_" + TASKS[i]] && mo.tasks.indexOf(TASKS[i]) < 0) return false;
    }
    return true;
  });
}

/* ---------- what changed since the last refresh ----------
   The site refreshes every Monday and until now said nothing about what moved,
   which made it a thing you had to remember to check. The card reads the same
   data/changelog.json that feed.xml is built from, so the page and the feed
   can never disagree. */

var LOG_LABEL = {
  baseline: "start",
  model_added: "new model",
  rank_move: "rank",
  upkeep: "upkeep",
  license: "licence",
  milestone: "milestone",
  benchmark_paper: "evaluation",
  citing: "citations",
  first_comparison: "first comparison"
};

/* Only http(s) becomes a link. Event urls are OpenAlex DOIs today, so this
   guards nothing that exists yet -- but the same events feed a reader, and a
   javascript: href is not worth carrying for a one-line check. */
function safeLink(url) {
  return /^https?:\/\//.test(String(url || ""));
}

function changelogCard() {
  var log = DATA.changelog;
  if (!log || !log.entries || !log.entries.length) return "";
  var entries = log.entries.slice().reverse();
  var shown = entries.slice(0, logWeeks);

  var weeks = shown.map(function (entry) {
    var events = entry.events || [];
    return '<div class="log-week"><div class="log-date">' + esc(entry.date) +
      (entries.length > 1 && entry === entries[0] ? " · latest refresh" : "") + "</div>" +
      (events.length
        ? events.map(function (ev) {
            return '<div class="log-item"><span class="log-kind k-' + esc(ev.type || "") +
              '">' + esc(LOG_LABEL[ev.type] || "change") + "</span><span>" + esc(ev.text) +
              (safeLink(ev.url) ? ' <a href="' + esc(ev.url) + '" rel="noopener">DOI</a>' : "") +
              "</span></div>";
          }).join("")
        : '<div class="log-item"><span class="log-kind">quiet</span><span>Nothing ' +
          "tracked changed this week.</span></div>") + "</div>";
  }).join("");

  return '<div class="card log-card"><h2>What changed</h2>' +
    '<p class="sub">Every Monday the pipeline re-reads all three sources; this is the ' +
    "difference from the run before. Rank moves are reported only when a model shifts at " +
    "least two places <em>and</em> its score moves by half a point, so a pair of neighbours " +
    "trading places on rounding does not read as news. " +
    '<a href="feed.xml">Atom feed</a>.</p>' + weeks +
    (entries.length > logWeeks
      ? '<button class="chip" id="log-more">Show earlier weeks</button>'
      : (logWeeks > 1
          ? '<button class="chip" id="log-less">Show only the latest</button>' : "")) +
    "</div>";
}

function renderModels() {
  var rows = activeModels().map(function (mo) {
    var copy = Object.create(mo);
    copy.liveScore = rescore(mo);
    return copy;
  });
  rows.sort(function (a, b) {
    var av = sortKey === "score" ? a.liveScore : a[sortKey];
    var bv = sortKey === "score" ? b.liveScore : b[sortKey];
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  var maxScore = Math.max.apply(null, rows.map(function (r) { return r.liveScore; }).concat([1]));

  var sliders = WEIGHT_KEYS.map(function (k) {
    return '<div class="slider"><label for="w-' + k + '">' + WEIGHT_LABELS[k] +
      " <b>" + Math.round(weights[k] * 100) + "%</b></label>" +
      '<input id="w-' + k + '" type="range" min="0" max="100" value="' +
      Math.round(weights[k] * 100) + '" data-w="' + k + '"></div>';
  }).join("");

  var chips = [
    ["open", "Open weights"], ["active", "Actively maintained"],
    ["surging", "Surging citations"], ["weights_hf", "On Hugging Face"]
  ].concat(TASKS.map(function (t) { return ["task_" + t, t]; }));

  var head = [
    ["rank", "#", ""], ["name", "Model", ""], ["score", "Score", "num"],
    ["citations", "Citations", "num"], ["", "Trend", ""],
    ["biology_share", "Biology", "num"],
    ["downloads", "HF 30d", "num"], ["stars", "Stars", "num"],
    ["days_since_push", "Upkeep", ""], ["runnable", "Runnable", "num"],
    ["params", "Params", "num"],
    ["cells", "Cells", "num"], ["", "Tasks", ""], ["license", "License", ""]
  ];

  el("view-models").innerHTML =
    changelogCard() +
    '<div class="card"><h2>Weight the score yourself</h2>' +
    '<div class="controls">' + sliders + "</div>" +
    '<div class="filters">' + chips.map(function (c) {
      return '<button class="chip' + (filters[c[0]] ? " on" : "") +
        '" data-f="' + c[0] + '">' + esc(c[1]) + "</button>";
    }).join("") + "</div>" +
    '<p class="sub" style="margin-bottom:0">Citations measure attention, downloads measure use, and ' +
    'last-commit date measures upkeep. Models that rank high on one and low on another are the ' +
    'ones worth a second look.</p></div>' +
    '<div class="card"><div class="table-scroll"><table><thead><tr>' +
    head.map(function (h) {
      return "<th" + (h[2] ? ' class="num' + (h[0] ? " sortable" : "") + '"' :
        (h[0] ? ' class="sortable"' : "")) +
        (h[0] ? ' data-sort="' + h[0] + '"' : "") + ">" + h[1] +
        (sortKey === h[0] ? (sortDir < 0 ? " ▾" : " ▴") : "") + "</th>";
    }).join("") + "</tr></thead><tbody>" +
    rows.map(function (mo, i) {
      var pct = (mo.liveScore / maxScore) * 100;
      return "<tr>" +
        '<td class="num">' + (i + 1) + "</td>" +
        '<td><span class="model-name" data-model="' + mo.id + '">' + esc(mo.name) + "</span>" +
        '<div class="model-org">' + esc(mo.org) + " · " + mo.year + "</div></td>" +
        '<td class="num"><span class="scorebar"><i style="width:' + pct.toFixed(0) +
        '%"></i><span>' + mo.liveScore.toFixed(1) + "</span></span></td>" +
        '<td class="num">' + num(mo.citations) + deltaTag(mo.citations_delta) + "</td>" +
        "<td>" + sparkline(mo.counts_by_year, 76, 22) +
        ' <span class="badge ' + mo.velocity + '">' + mo.velocity + "</span></td>" +
        '<td class="num">' + bioShareCell(mo) + "</td>" +
        '<td class="num">' + (mo.hf ? num(mo.downloads) : "—") + "</td>" +
        '<td class="num">' + (mo.github ? num(mo.stars) : "—") + deltaTag(mo.stars_delta) + "</td>" +
        '<td><span class="badge ' + mo.upkeep + '">' + mo.upkeep + "</span>" +
        (mo.days_since_push != null ? '<div class="model-org">' + mo.days_since_push + "d ago</div>" : "") +
        "</td>" +
        '<td class="num">' + runnableCell(mo) + "</td>" +
        '<td class="num">' + compact(mo.params) + "</td>" +
        '<td class="num">' + compact(mo.cells) + "</td>" +
        '<td><div class="tasks">' + mo.tasks.map(function (t) {
          return '<span class="task-dot">' + t + "</span>";
        }).join("") + "</div></td>" +
        "<td>" + licenseCell(mo.license) + "</td>" +
        "</tr>";
    }).join("") + "</tbody></table></div>" +
    '<p class="sub">' + rows.length + " of " + DATA.models.length +
    " models shown. Click a model name for its detail page.</p></div>";

  bindChangelogButtons();
}

/* Share of a model's classified citations that are biology work, rendered as a
   bar. Deliberately not coloured as good or bad: a low number can mean the
   model is a methods plaything, or simply that biologists cite the tool paper
   less than tool-builders do. The page states the ambiguity rather than
   resolving it with a colour. */
function bindChangelogButtons() {
  var more = el("log-more"), less = el("log-less");
  if (more) more.onclick = function () { logWeeks += 4; renderModels(); };
  if (less) less.onclick = function () { logWeeks = 1; renderModels(); };
}

/* ---------- runnability ----------
   Citations say the field noticed a model; this says whether you could install
   it this afternoon. The signals are deliberately boring and checkable: a
   package, a pinned environment, a tagged release, worked examples, and
   somebody closing issues. */

var RUNNABLE_SIGNALS = [
  ["installable", "on PyPI"],
  ["env", "pinned environment"],
  ["release", "tagged release"],
  ["tutorials", "worked examples"],
  ["responsive", "issues answered (90d)"]
];

function runnableCell(mo) {
  if (mo.runnable == null) return '<span class="sub" title="No repository to inspect">—</span>';
  return Math.round(mo.runnable * 100);
}

function runnablePanel(mo) {
  var d = mo.runnable_detail;
  if (!d) {
    return '<div class="card"><h2>Can you run it?</h2><p class="sub">' +
      esc(shortName(mo.name)) + " publishes neither a GitHub repository nor Hugging " +
      "Face weights, so none of these signals can be read for it. It is scored on the " +
      "four components that can be measured rather than carrying a zero here.</p></div>";
  }
  var facts = [];
  if (d.pypi) facts.push("<code>pip install " + esc(d.pypi) + "</code>");
  if (d.release) facts.push("latest release <strong>" + esc(d.release) + "</strong>");
  if (d.env_files && d.env_files.length) facts.push(esc(d.env_files.join(", ")));
  if (d.dockerfile) facts.push("Dockerfile");
  if (d.notebooks) facts.push(d.notebooks + " notebook" + (d.notebooks === 1 ? "" : "s"));
  if (d.closed_issues_90d != null) {
    facts.push(d.closed_issues_90d + " issue" + (d.closed_issues_90d === 1 ? "" : "s") +
      " closed in 90 days");
  }

  var rows = RUNNABLE_SIGNALS.map(function (sig) {
    var v = d.signals[sig[0]];
    var mark = v == null ? '<span class="sig-unknown">not measured</span>'
      : v >= 1 ? '<span class="sig-yes">yes</span>'
      : v > 0 ? '<span class="sig-part">' + Math.round(v * 100) + "%</span>"
      : '<span class="sig-no">no</span>';
    return '<div class="sig"><span>' + esc(sig[1]) + "</span>" + mark + "</div>";
  }).join("");

  return '<div class="card"><h2>Can you run it?</h2>' +
    '<p class="sub">Scored <strong>' + Math.round(mo.runnable * 100) + "/100</strong>" +
    (d.observed_weight < 1
      ? " on the " + Math.round(d.observed_weight * 100) + "% of signals that could be read"
      : "") + ". " + (facts.length ? facts.join(" · ") : "None of these are present.") + "</p>" +
    '<div class="sigs">' + rows + "</div>" +
    '<p class="sub">A closed issue in the last 90 days is the cheapest evidence that ' +
    "somebody is still answering. None of this judges the model — a research repo with " +
    "no package can still be the right one to read.</p></div>";
}

function bioShareCell(mo) {
  if (mo.biology_share == null) return "—";
  var pct = Math.round(mo.biology_share * 100);
  var dc = mo.domain_counts || {};
  // Scaled against a 30% ceiling: nothing in this corpus comes close to half,
  // so a 0-100 track would render every model as a flat empty bar.
  var fill = Math.min(100, (pct / 30) * 100);
  return '<span class="bioshare" title="' + (dc.biology || 0) + " biology / " +
    ((dc.biology || 0) + (dc.method || 0)) + ' classified as method or biology">' +
    '<i style="width:' + fill.toFixed(0) + '%"></i><b>' + pct + "%</b></span>";
}

/* ---------- model detail ---------- */
function loadCiting(id) {
  if (citingFull[id] !== undefined) return;
  citingFull[id] = null;
  fetch("data/citations/" + encodeURIComponent(id) + ".json")
    .then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(function (recs) { citingFull[id] = recs; })
    .catch(function () { citingFull[id] = false; })
    .then(function () {
      // Only repaint if the reader is still on this model's page.
      if (!el("view-detail").hidden && el("view-detail").dataset.model === id) {
        renderDetail(id);
      }
    });
}

function renderDetail(id) {
  var mo = DATA.models.filter(function (m) { return m.id === id; })[0];
  if (!mo) return;
  loadCiting(id);
  var full = citingFull[id];
  var arts = full || DATA.citations[id] || [];
  var uses = mo.use_counts || {};
  el("view-detail").dataset.model = id;

  var specs = [
    [compact(mo.params), "parameters"], [compact(mo.cells), "pretraining cells"],
    [num(mo.citations), "citations (deduped)"], [num(mo.citations_naive_sum), "naive version sum"],
    [num(mo.citations_12m), "citations, last 12 months"],
    [mo.github ? num(mo.stars) : "—", "GitHub stars"],
    [mo.hf ? num(mo.downloads) : "—", "HF downloads / 30d"],
    [mo.upkeep, "upkeep"], [mo.velocity, "citation velocity" + (mo.velocity_ratio ? " (" + mo.velocity_ratio + "×)" : "")]
  ];

  var links = [];
  if (mo.github) links.push('<a href="' + esc(mo.github.url) + '" rel="noopener">GitHub</a>');
  if (mo.hf) {
    mo.hf.repos.forEach(function (r) {
      links.push('<a href="' + esc(r.url) + '" rel="noopener">' + esc(r.id) + "</a>");
    });
  }

  el("view-detail").innerHTML =
    '<button class="back" id="back-btn">← Back to leaderboard</button>' +
    '<div class="card"><h2>' + esc(mo.name) + "</h2>" +
    '<p class="sub">' + esc(mo.org) + " · " + mo.year + " · licence " +
    (isUnclearLicense(mo.license) ? "unclear" : esc(mo.license)) + "</p>" +
    (mo.notes ? "<p>" + esc(mo.notes) + "</p>" : "") +
    (links.length ? '<p class="sub">' + links.join(" · ") + "</p>" : "") +
    '<div class="spec-grid">' + specs.map(function (s) {
      return '<div class="spec"><b>' + esc(s[0]) + "</b><span>" + esc(s[1]) + "</span></div>";
    }).join("") + "</div></div>" +

    '<div class="card"><h2>Score breakdown</h2>' +
    WEIGHT_KEYS.map(function (k) {
      var v = mo.components[k];
      if (v == null) {
        return '<div style="margin-bottom:8px"><div class="sub">' + WEIGHT_LABELS[k] +
          " — not measurable for this model, so it is left out of the score rather " +
          "than counted as zero</div></div>";
      }
      return '<div style="margin-bottom:8px"><div class="sub">' + WEIGHT_LABELS[k] +
        " — " + (v * 100).toFixed(0) + "%</div>" +
        '<div style="height:7px;background:var(--grid);border-radius:4px">' +
        '<div style="height:7px;width:' + (v * 100).toFixed(0) +
        '%;background:var(--seq-450);border-radius:4px"></div></div></div>';
    }).join("") + "</div>" +

    runnablePanel(mo) +

    '<div class="card"><h2>Papers</h2>' + mo.papers.map(function (p) {
      return '<div class="art"><div class="t">' + esc(p.title) + "</div>" +
        '<div class="m">' + esc(p.venue || p.type || "") + " · " + (p.year || "") +
        " · " + num(p.cited_by_count) + " citations" +
        (p.doi ? ' · <a href="' + esc(p.doi) + '" rel="noopener">DOI</a>' : "") + "</div></div>";
    }).join("") +
    '<p class="sub">Deduped total is ' + num(mo.citations) + ", versus " +
    num(mo.citations_naive_sum) + " if versions were simply summed — the gap is papers citing more than one version.</p></div>" +

    rivalPanel(mo) +

    '<div class="card"><h2>Who is citing it</h2>' + domainPanel(mo) +
    '<h2 style="margin-top:22px">How the ' + num(mo.citations) + " citing papers use it</h2>" +
    '<p class="sub">' + ["application", "benchmark", "extension", "review"].map(function (u) {
      return '<span class="use-' + u + '">' + u + ": " + (uses[u] || 0) + "</span>";
    }).join(" · ") + "</p>" +
    "<h2>Citing articles</h2>" + citingNote(mo, arts, full) +
    arts.slice(0, citingShown).map(articleRow).join("") +
    (arts.length > citingShown
      ? '<button class="chip" id="more-citing">Show ' +
        Math.min(CITING_PAGE, arts.length - citingShown) + " more</button>"
      : "") + "</div>";

  el("back-btn").onclick = function () { show("models"); };
  var more = el("more-citing");
  if (more) {
    more.onclick = function () { citingShown += CITING_PAGE; renderDetail(id); };
  }
}

/* Which models the same benchmarking papers evaluate alongside this one.
   Ranked by how many such papers there are, which is the closest thing the
   corpus has to "what the field compares this against". */
function rivalPanel(mo) {
  var h = DATA.h2h;
  if (!h || !h.totals[mo.id]) return "";

  var rivals = h.order.filter(function (id) { return id !== mo.id && modelById(id); })
    .map(function (id) { return {id: id, cell: pairCell(pairKey(mo.id, id))}; })
    .filter(function (r) { return r.cell.bench > 0; })
    .sort(function (a, b) { return b.cell.bench - a.cell.bench; });

  var own = h.totals[mo.id].bench;
  if (!rivals.length) {
    return '<div class="card"><h2>Benchmarked against</h2><p class="sub">No paper in the ' +
      "corpus evaluates " + esc(shortName(mo.name)) + " alongside another tracked model" +
      (own ? " — " + own + " benchmarking paper" + (own === 1 ? "" : "s") + " cite" +
        (own === 1 ? "s" : "") + " it on its own." : " yet.") +
      " That is missing evidence rather than a poor result; models published recently " +
      "sit here until the first independent evaluation lands.</p></div>";
  }

  return '<div class="card"><h2>Benchmarked against</h2>' +
    '<p class="sub">Papers that evaluate rather than apply, and cite both models. ' +
    own + " benchmarking paper" + (own === 1 ? "" : "s") + " cite " +
    esc(shortName(mo.name)) + " in total.</p>" +
    '<div class="rivals">' + rivals.slice(0, 8).map(function (r) {
      return '<div class="rival"><span class="model-name" data-model="' + r.id + '">' +
        esc(h2hName(r.id)) + '</span><span class="rival-n">' + r.cell.bench + "</span></div>";
    }).join("") + "</div>" +
    (rivals.length > 8 ? '<p class="sub">' + (rivals.length - 8) +
      " further pairing(s) with fewer papers — see the head-to-head matrix.</p>" : "") +
    "</div>";
}

/* The method/biology split, with the abstentions kept visible. Hiding
   "unclear" inside the denominator would make the biology share look more
   precise than the classifier earns. */
function domainPanel(mo) {
  var dc = mo.domain_counts || {};
  var order = ["method", "biology", "unclear", "offtopic"];
  var total = order.reduce(function (n, k) { return n + (dc[k] || 0); }, 0);
  if (!total) return '<p class="sub">Not yet classified.</p>';

  var bar = '<div class="dombar">' + order.map(function (k) {
    var v = dc[k] || 0;
    if (!v) return "";
    return '<i class="dom-' + k + '" style="width:' + (100 * v / total) +
      '%" title="' + k + ": " + v + '"></i>';
  }).join("") + "</div>";

  var legend = '<p class="sub">' + order.map(function (k) {
    return '<span class="dom-key dom-' + k + '"></span>' + k + ": " + (dc[k] || 0);
  }).join(" · ") + "</p>";

  var share = mo.biology_share == null ? "" :
    "<p><strong>" + Math.round(mo.biology_share * 100) + "%</strong> of the " +
    ((dc.biology || 0) + (dc.method || 0)) + " citations the classifier could call " +
    "are biology papers; the rest are computational work. " +
    (dc.unclear ? dc.unclear + " were too ambiguous to call and sit outside that ratio. " : "") +
    "</p>";

  return bar + legend + share +
    '<p class="sub">Labels come from each citing paper\'s title and abstract, not its full ' +
    "text — so this counts what kind of work cites the model, which is not the same as what " +
    "kind of work <em>runs</em> it. A biology paper citing the model once in its introduction " +
    "still counts here.</p>";
}

/* The count matters here: the score, the year histogram and the field split are
   all computed over every citation, so a page showing a truncated list has to
   say so rather than let the reader read the visible rows as the whole corpus. */
function citingNote(mo, arts, full) {
  var shown = Math.min(citingShown, arts.length);
  // Most models have fewer citations than the index cap, so their index *is*
  // the whole list -- no point warning about a fetch that will not add a row.
  if (!full && arts.length < mo.citations) {
    return '<p class="sub">Showing the ' + num(shown) + " most recent of " +
      num(mo.citations) + (full === false
        ? ". The full list could not be loaded.</p>"
        : " — loading the rest…</p>");
  }
  return '<p class="sub">Showing ' + num(shown) + " of " + num(arts.length) +
    ", most recent first.</p>";
}

function articleRow(a) {
  return '<div class="art"><div class="t">' +
    (a.doi ? '<a href="' + esc(a.doi) + '" rel="noopener">' + esc(a.title) + "</a>" : esc(a.title)) +
    '</div><div class="m"><span class="use-' + a.use + '">' + a.use + "</span> · " +
    '<span class="dom-tag dom-' + a.domain + '">' + a.domain + "</span> · " +
    esc(a.first_author || "—") + (a.n_authors > 1 ? " et al." : "") +
    " · " + esc(a.venue || "unlisted") + " · " + (a.date || a.year || "") + "</div></div>";
}

/* ---------- landscape: citations x usage ----------
   The point of this view is that the two axes disagree. Median crosshairs split
   the plane into four quadrants so "cited but nobody runs it" is a position on
   screen rather than a claim in prose. */

function shortName(name) { return name.replace(/ \(.*/, "").replace(/ \/ .*/, ""); }
function hasUsageData(mo) { return !!(mo.github || mo.hf); }
function usageValue(mo) { return (mo.stars || 0) + (mo.downloads || 0); }

function median(values) {
  var s = values.slice().sort(function (a, b) { return a - b; });
  if (!s.length) return 0;
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* Greedy label placement: try four offsets, take the first that does not
   collide with a label already placed. Anything that cannot be placed is left
   to the hover card rather than allowed to overlap. */
function placeLabels(items) {
  var placed = [];
  items.forEach(function (item) {
    var w = item.text.length * 6.1, h = 12;
    var candidates = [
      [item.cx - w / 2, item.cy - item.r - 6 - h],
      [item.cx - w / 2, item.cy + item.r + 4],
      [item.cx + item.r + 5, item.cy - h / 2],
      [item.cx - item.r - 5 - w, item.cy - h / 2]
    ];
    for (var i = 0; i < candidates.length; i++) {
      var box = {x: candidates[i][0], y: candidates[i][1], w: w, h: h};
      var hit = placed.some(function (p) {
        return !(box.x + box.w < p.x || p.x + p.w < box.x ||
                 box.y + box.h < p.y || p.y + p.h < box.y);
      });
      if (!hit) {
        placed.push(box);
        item.label = {x: box.x + w / 2, y: box.y + h - 2};
        return;
      }
    }
  });
  return items;
}

function renderLandscape() {
  var plotted = DATA.models.filter(hasUsageData);
  var missing = DATA.models.filter(function (m) { return !hasUsageData(m); });

  var W = 1040, H = 520, P = {t: 22, r: 28, b: 56, l: 72};
  var lg = function (v) { return Math.log10((v || 0) + 1); };
  var xmax = Math.ceil(Math.max.apply(null, plotted.map(function (m) { return lg(m.citations); })));
  var ymax = Math.ceil(Math.max.apply(null, plotted.map(function (m) { return lg(usageValue(m)); })));
  var X = function (v) { return P.l + (lg(v) / xmax) * (W - P.l - P.r); };
  var Y = function (v) { return H - P.b - (lg(v) / ymax) * (H - P.t - P.b); };
  var cmax = Math.max.apply(null, DATA.models.map(function (m) { return m.cells || 0; })) || 1;
  var R = function (c) { return 5 + 11 * Math.sqrt((c || 0) / cmax); };

  var mx = median(plotted.map(function (m) { return m.citations; }));
  var my = median(plotted.map(function (m) { return usageValue(m); }));

  var svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" ' +
    'aria-label="Citations versus usage for every tracked model">';

  for (var e = 0; e <= xmax; e++) {
    var gx = P.l + (e / xmax) * (W - P.l - P.r);
    svg += '<line x1="' + gx + '" y1="' + P.t + '" x2="' + gx + '" y2="' + (H - P.b) +
      '" stroke="var(--grid)" stroke-width="1"/>' +
      '<text x="' + gx + '" y="' + (H - P.b + 18) + '" fill="var(--muted)" font-size="11" ' +
      'text-anchor="middle">' + Math.pow(10, e).toLocaleString() + "</text>";
  }
  for (var f = 0; f <= ymax; f++) {
    var gy = H - P.b - (f / ymax) * (H - P.t - P.b);
    svg += '<line x1="' + P.l + '" y1="' + gy + '" x2="' + (W - P.r) + '" y2="' + gy +
      '" stroke="var(--grid)" stroke-width="1"/>' +
      '<text x="' + (P.l - 9) + '" y="' + (gy + 4) + '" fill="var(--muted)" font-size="11" ' +
      'text-anchor="end">' + Math.pow(10, f).toLocaleString() + "</text>";
  }

  svg += '<line x1="' + X(mx) + '" y1="' + P.t + '" x2="' + X(mx) + '" y2="' + (H - P.b) +
    '" stroke="var(--baseline)" stroke-width="1" stroke-dasharray="4 4"/>' +
    '<line x1="' + P.l + '" y1="' + Y(my) + '" x2="' + (W - P.r) + '" y2="' + Y(my) +
    '" stroke="var(--baseline)" stroke-width="1" stroke-dasharray="4 4"/>' +
    '<text class="quad-note" x="' + (W - P.r - 8) + '" y="' + (H - P.b - 9) +
    '" text-anchor="end">cited, but little used →</text>' +
    '<text class="quad-note" x="' + (P.l + 8) + '" y="' + (P.t + 14) + '">← used, but little cited</text>';

  svg += '<text x="' + ((W + P.l) / 2) + '" y="' + (H - 12) +
    '" fill="var(--ink-2)" font-size="12.5" text-anchor="middle">citations (log scale)</text>' +
    '<text x="18" y="' + (H / 2) + '" fill="var(--ink-2)" font-size="12.5" text-anchor="middle" ' +
    'transform="rotate(-90 18 ' + (H / 2) + ')">GitHub stars + HF downloads (log scale)</text>';

  var items = placeLabels(plotted.map(function (m) {
    return {id: m.id, text: shortName(m.name), cx: X(m.citations),
            cy: Y(usageValue(m)), r: R(m.cells)};
  }).sort(function (a, b) { return b.r - a.r; }));

  // Two passes: every dot, then every label. Interleaving them lets a dot drawn
  // later paint over an earlier label.
  var labels = "";
  items.forEach(function (item) {
    var mo = DATA.models.filter(function (m) { return m.id === item.id; })[0];
    svg += '<circle class="dot" data-dot="' + mo.id + '" cx="' + item.cx.toFixed(1) +
      '" cy="' + item.cy.toFixed(1) + '" r="' + item.r.toFixed(1) +
      '" fill="var(--' + statusVar(mo.upkeep) + ')" fill-opacity=".55" ' +
      'stroke="var(--surface)" stroke-width="2"><title>' + esc(mo.name) + "</title></circle>";
    if (item.label) {
      labels += '<text class="dot-label" x="' + item.label.x.toFixed(1) + '" y="' +
        item.label.y.toFixed(1) + '" fill="var(--ink)" font-size="11.5" ' +
        'text-anchor="middle" stroke="var(--page)" stroke-width="3" ' +
        'paint-order="stroke">' + esc(item.text) + "</text>";
    }
  });
  svg += labels + "</svg>";

  el("view-landscape").innerHTML =
    '<div class="card"><h2>Attention is not usage</h2>' +
    '<p class="sub">Each model plotted by how often it is cited against how often it is actually ' +
    'pulled. Dashed lines are the medians. A model low and to the right is one the field writes ' +
    'about but does not run; high and to the left is the opposite. Dot size is pretraining corpus ' +
    'size; colour is upkeep. Click any model to open its page.</p>' +
    '<div class="chart-legend">' +
    '<span><i style="background:var(--good)"></i>active — commit within 90 days</span>' +
    '<span><i style="background:var(--warning)"></i>slowing — within a year</span>' +
    '<span><i style="background:var(--critical)"></i>dormant — over a year</span>' +
    "</div>" + svg +
    (missing.length ? '<p class="sub">' + missing.length + " model(s) not plotted — " +
      missing.map(function (m) { return esc(shortName(m.name)); }).join(", ") +
      " — because no GitHub repo or Hugging Face weights are registered for them. That is " +
      "missing data, not zero usage.</p>" : "") +
    "</div>";
}

function statusVar(upkeep) {
  if (upkeep === "active") return "good";
  if (upkeep === "slowing") return "warning";
  if (upkeep === "dormant" || upkeep === "archived") return "critical";
  return "muted";
}

/* ---------- capability matrix ---------- */
function renderMatrix() {
  var rows = DATA.models.slice().sort(function (a, b) { return b.score - a.score; });
  var unclear = 0;

  var body = rows.map(function (mo) {
    var isUnclear = isUnclearLicense(mo.license);
    if (isUnclear) unclear++;
    return "<tr>" +
      '<td><span class="model-name" data-model="' + mo.id + '">' + esc(shortName(mo.name)) +
      '</span><div class="model-org">' + mo.year + "</div></td>" +
      TASKS.map(function (t) {
        var on = mo.tasks.indexOf(t) >= 0;
        return '<td class="c"><span class="cell' + (on ? " on" : "") + '" title="' +
          esc(mo.name + (on ? " supports " : " does not support ") + t) + '"></span></td>';
      }).join("") +
      '<td class="num">' + compact(mo.params) + "</td>" +
      '<td class="num">' + compact(mo.cells) + "</td>" +
      "<td>" + licenseCell(mo.license) + "</td>" +
      '<td><span class="status-dot status-' + mo.upkeep + '">●</span> <span class="sub">' +
      mo.upkeep + "</span></td>" +
      '<td class="num">' + num(mo.citations) + "</td></tr>";
  }).join("");

  el("view-matrix").innerHTML =
    '<div class="card"><h2>What each model can actually do</h2>' +
    '<p class="sub">Every tracked model against every supported task, plus the two facts that ' +
    'decide whether you can use it: what the licence permits, and whether anyone still maintains ' +
    'it. Task support is as claimed by each model’s own paper, not independently verified.</p>' +
    '<div class="table-scroll"><table class="matrix"><thead><tr><th>Model</th>' +
    TASKS.map(function (t) { return '<th class="c">' + t + "</th>"; }).join("") +
    '<th class="num">Params</th><th class="num">Cells</th><th>Licence</th>' +
    "<th>Upkeep</th><th class=\"num\">Citations</th></tr></thead><tbody>" +
    body + "</tbody></table></div>" +
    '<p class="sub">' + unclear + " of " + rows.length +
    " models ship without a clear licence — for those, weights being downloadable is not the " +
    "same as permission to use them.</p></div>";
}

/* ---------- hover card ---------- */
document.addEventListener("mouseover", function (e) {
  var key = e.target.dataset && e.target.dataset.pair;
  if (key) {
    var parts = key.split("|"), cell = pairCell(key), tipEl = el("tooltip");
    tipEl.innerHTML = "<b>" + esc(h2hName(parts[0])) + " vs " + esc(h2hName(parts[1])) + "</b>" +
      '<div class="row"><span>benchmarking papers citing both</span><span>' + cell.bench + "</span></div>" +
      '<div class="row"><span>papers citing both, any use</span><span>' + num(cell.any) + "</span></div>" +
      '<div class="sub">' + (cell.bench ? "Click to read them." : "Cited together, never jointly evaluated.") + "</div>";
    tipEl.hidden = false;
    return;
  }
  var id = e.target.dataset && e.target.dataset.dot;
  if (!id) return;
  var mo = DATA.models.filter(function (m) { return m.id === id; })[0];
  if (!mo) return;
  var tip = el("tooltip");
  tip.innerHTML = "<b>" + esc(mo.name) + "</b>" +
    '<div class="sub">' + esc(mo.org) + " · " + mo.year + "</div>" +
    '<div class="row"><span>citations</span><span>' + num(mo.citations) + "</span></div>" +
    '<div class="row"><span>GitHub stars</span><span>' + (mo.github ? num(mo.stars) : "—") + "</span></div>" +
    '<div class="row"><span>HF downloads</span><span>' + (mo.hf ? num(mo.downloads) : "—") + "</span></div>" +
    '<div class="row"><span>pretraining cells</span><span>' + compact(mo.cells) + "</span></div>" +
    '<div class="row"><span>upkeep</span><span class="status-' + mo.upkeep + '">' +
    mo.upkeep + (mo.days_since_push != null ? " (" + mo.days_since_push + "d)" : "") + "</span></div>";
  tip.hidden = false;
});
document.addEventListener("mousemove", function (e) {
  var tip = el("tooltip");
  if (tip.hidden) return;
  var x = e.clientX + 14, y = e.clientY + 14;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = e.clientX - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 14;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
});
document.addEventListener("mouseout", function (e) {
  var d = e.target.dataset;
  if (d && (d.dot || d.pair)) el("tooltip").hidden = true;
});

/* ---------- head-to-head: who gets evaluated against whom ----------
   A citing paper labelled "benchmark" that cites two tracked models is an
   independent evaluation covering both. The label is a property of the citing
   paper, so it is the same for every model that paper cites and the matrix is
   symmetric by construction. What it cannot know is which models a benchmark
   actually put in the same table; that limitation is stated on the page rather
   than left for the reader to assume away. */

function modelById(id) {
  return DATA.models.filter(function (m) { return m.id === id; })[0];
}
function h2hName(id) {
  var mo = modelById(id);
  return mo ? shortName(mo.name) : id;
}
function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
function pairCell(key) {
  return (DATA.h2h && DATA.h2h.pairs[key]) || {bench: 0, any: 0};
}
/* Four bands rather than a continuous ramp: the counts span 1 to 56, and a
   smooth scale would render most of the matrix as indistinguishable pale blue
   while making the numbers in the dark cells unreadable. */
function h2hTier(n) {
  if (!n) return 0;
  if (n < 5) return 1;
  if (n < 15) return 2;
  if (n < 30) return 3;
  return 4;
}

function renderH2H() {
  var h = DATA.h2h;
  if (!h) {
    el("view-h2h").innerHTML =
      '<div class="card"><h2>Head-to-head</h2><p class="sub">This view reads ' +
      "data/headtohead.json, which this deployment does not carry yet — it is " +
      "written by the next weekly refresh.</p></div>";
    return;
  }

  var ids = h.order.filter(modelById);
  var never = ids.filter(function (id) {
    return ids.every(function (other) {
      return other === id || !pairCell(pairKey(id, other)).bench;
    });
  });

  var head = '<th class="h2h-corner"><span class="sub">evaluated with →</span></th>' +
    ids.map(function (id) {
      return '<th class="h2h-col"><span>' + esc(h2hName(id)) + "</span></th>";
    }).join("");

  var body = ids.map(function (r) {
    return '<tr><th class="h2h-row"><span class="model-name" data-model="' + r +
      '">' + esc(h2hName(r)) + "</span></th>" +
      ids.map(function (c) {
        if (r === c) {
          var t = h.totals[r] || {bench: 0};
          return '<td class="h2h-diag"><span title="' + esc(h2hName(r)) + ": " +
            t.bench + ' benchmarking papers cite it at all">' + (t.bench || "—") +
            "</span></td>";
        }
        var key = pairKey(r, c), cell = pairCell(key);
        return '<td class="h2h-cell t' + h2hTier(cell.bench) +
          (h2hPair === key ? " sel" : "") + '" data-pair="' + key + '">' +
          (cell.bench || "") + "</td>";
      }).join("") + "</tr>";
  }).join("");

  var selected = h.papers;
  var caption = "All " + h.papers.length + " benchmarking papers that cite two or more tracked models";
  if (h2hPair) {
    var pm = h2hPair.split("|");
    selected = h.papers.filter(function (p) {
      return p.models.indexOf(pm[0]) >= 0 && p.models.indexOf(pm[1]) >= 0;
    });
    caption = h2hName(pm[0]) + " vs " + h2hName(pm[1]) + " — " + selected.length +
      " benchmarking paper" + (selected.length === 1 ? "" : "s") + " citing both, of " +
      num(pairCell(h2hPair).any) + " papers that cite both for any reason";
  }

  el("view-h2h").innerHTML =
    '<div class="card"><h2>Which models are actually evaluated against each other</h2>' +
    '<p class="sub">Each cell counts the papers that <em>benchmark</em> — evaluate or compare ' +
    "rather than apply — and cite both models. That is the field's own comparison record: " +
    h.comparison_papers + " of the " + h.benchmark_papers + " benchmarking papers in the corpus " +
    "cite two or more tracked models. The diagonal is how many benchmarking papers cite that " +
    "model at all. Click a cell to read the papers behind it.</p>" +
    '<div class="chart-legend h2h-legend">' +
    [["t1", "1–4 papers"], ["t2", "5–14"], ["t3", "15–29"], ["t4", "30+"]].map(function (b) {
      return '<span><i class="h2h-swatch ' + b[0] + '"></i>' + b[1] + "</span>";
    }).join("") + "</div>" +
    '<div class="table-scroll"><table class="matrix h2h"><thead><tr>' + head +
    "</tr></thead><tbody>" + body + "</tbody></table></div>" +
    '<p class="sub"><strong>A blank cell is missing evidence, not a verdict.</strong> It means no ' +
    "paper in the corpus evaluated the two together — which for a model published this year is " +
    "the expected state, not a mark against it." +
    (never.length ? " " + never.map(function (id) { return esc(h2hName(id)); }).join(", ") +
      " ha" + (never.length === 1 ? "s" : "ve") + " not yet been jointly evaluated with anything " +
      "on this list." : "") + "</p>" +
    '<p class="sub">The label belongs to the citing paper, not to the pair: this counts ' +
    "benchmarking papers that cite both models, which is not proof the two appeared in the same " +
    "table. A paper that evaluates one and cites the other only in its introduction is counted " +
    "here. Labels come from a rules-based classifier — 89% accurate on 92 hand-checked papers — " +
    "so treat a difference of one or two papers as noise.</p></div>" +

    '<div class="card"><h2>' + esc(caption) + "</h2>" +
    (h2hPair ? '<button class="chip on" id="h2h-clear">← every comparison paper</button>' : "") +
    (selected.length ? selected.map(h2hPaperRow).join("")
      : '<p class="sub">No benchmarking paper in the corpus cites both.</p>') +
    "</div>";

  var clear = el("h2h-clear");
  if (clear) clear.onclick = function () { h2hPair = null; renderH2H(); };
}

function h2hPaperRow(p) {
  return '<div class="art"><div class="t">' +
    (p.doi ? '<a href="' + esc(p.doi) + '" rel="noopener">' + esc(p.title) + "</a>"
           : esc(p.title)) +
    '</div><div class="m">' + esc(p.first_author || "—") +
    (p.n_authors > 1 ? " et al." : "") + " · " + esc(p.venue || "unlisted") +
    " · " + (p.date || p.year || "") + " · cited " + num(p.cited_by_count || 0) +
    "×</div>" +
    '<div class="m h2h-tags">covers ' + p.models.map(function (id) {
      return '<span class="model-name" data-model="' + id + '">' + esc(h2hName(id)) +
        "</span>";
    }).join(", ") + "</div></div>";
}

/* ---------- citing-articles feed ---------- */
function renderCitations() {
  var all = [];
  Object.keys(DATA.citations).forEach(function (mid) {
    var model = DATA.models.filter(function (m) { return m.id === mid; })[0];
    DATA.citations[mid].forEach(function (a) {
      var copy = {};
      for (var k in a) copy[k] = a[k];
      copy.model = model ? model.name : mid;
      all.push(copy);
    });
  });
  all.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });

  var useFilter = filters.use || "all";
  var domFilter = filters.domain || "all";
  var shown = all.filter(function (a) {
    return (useFilter === "all" || a.use === useFilter) &&
           (domFilter === "all" || a.domain === domFilter);
  });

  el("view-citations").innerHTML =
    '<div class="card"><h2>What is citing these models</h2>' +
    '<p class="sub">Every citing paper carries two labels. <em>Use</em> is what the paper does ' +
    'with the model — <strong>benchmark</strong> papers evaluated it rather than applied it, which ' +
    'is where critical findings live. <em>Field</em> is what kind of work the paper is: ' +
    '<strong>method</strong> for new computational tools, <strong>biology</strong> for papers ' +
    'making a claim about cells, tissue, or disease.</p>' +
    '<div class="filters">' + ["all", "application", "benchmark", "extension", "review"].map(function (u) {
      return '<button class="chip' + (useFilter === u ? " on" : "") + '" data-use="' + u + '">' + u + "</button>";
    }).join("") + "</div>" +
    '<div class="filters">' + ["all", "method", "biology", "unclear", "offtopic"].map(function (d) {
      return '<button class="chip' + (domFilter === d ? " on" : "") + '" data-domain="' + d +
        '">' + (d === "all" ? "all fields" : d) + "</button>";
    }).join("") + "</div></div>" +
    '<div class="card">' + shown.slice(0, 300).map(function (a) {
      return '<div class="art"><div class="t">' +
        (a.doi ? '<a href="' + esc(a.doi) + '" rel="noopener">' + esc(a.title) + "</a>" : esc(a.title)) +
        '</div><div class="m">cites <strong>' + esc(a.model) + '</strong> · <span class="use-' +
        a.use + '">' + a.use + "</span> · " + '<span class="dom-tag dom-' + a.domain +
        '">' + a.domain + "</span> · " + esc(a.venue || "unlisted") +
        " · " + (a.date || a.year || "") + "</div></div>";
    }).join("") +
    '<p class="sub">Showing ' + Math.min(300, shown.length) + " of " + shown.length +
    " — this feed indexes the " + DATA.meta.citing_index_per_model +
    " most recent citing articles per model. Open a model to see all " +
    num(DATA.meta.citing_records_total) + " on record.</p></div>";
}

/* ---------- about ---------- */
function renderAbout() {
  var m = DATA.meta;
  el("about-dynamic").innerHTML =
    '<div class="card"><h2>How the score works</h2>' +
    "<p>Each model is scored 0–100 from five components, weighted by default as " +
    WEIGHT_KEYS.map(function (k) {
      return Math.round((m.weights ? m.weights[k] : weights[k]) * 100) + "% " + WEIGHT_LABELS[k].toLowerCase();
    }).join(", ") + ". The leaderboard sliders re-weight everything live.</p>" +
    "<ul><li><strong>Attention</strong> — log-scaled total citations, deduplicated across every " +
    "version of the model paper.</li>" +
    "<li><strong>Momentum</strong> — citations gained recently: " + esc(m.momentum_basis) +
    ", counted from the publication date on each citing paper rather than from the " +
    "difference between two weekly snapshots. That makes it exact from the first run and " +
    "equally valid for a model added yesterday.</li>" +
    "<li><strong>Usage</strong> — Hugging Face downloads plus GitHub stars. Absent Hugging Face " +
    "numbers mean weights are distributed elsewhere, not that nobody uses the model.</li>" +
    "<li><strong>Openness &amp; upkeep</strong> — open weights, license permissiveness, and days " +
    "since the last commit.</li></ul>" +
    "<p class='sub'>Deduplication matters: a review citing both the bioRxiv and the journal version " +
    "of a model paper counts once. Summing versions instead would inflate the best-known models most.</p></div>" +
    '<div class="card"><h2>What kind of work cites these models</h2>' +
    (m.biology_share == null ? "" :
      "<p>Across " + num(m.unique_citing_works) + " unique citing papers, <strong>" +
      Math.round(m.biology_share * 100) + "%</strong> of those the classifier could call are " +
      "biology work; the rest are computational. That ratio, not the raw citation count, is " +
      "the honest read on whether these models have reached the bench.</p>") +
    "<p class='sub'>Every citing paper is labelled from its title, abstract, and OpenAlex " +
    "topics by a rules-based classifier (<code>pipeline/classify.py</code>). It abstains when " +
    "the evidence is thin rather than guessing, and those abstentions are excluded from the " +
    "ratio above instead of being counted as non-biology.</p>" +
    "<p class='sub'>Measured against " + "92 hand-labelled papers (<code>pipeline/labels.json</code>): " +
    "89% accurate overall, 95% accurate on the papers it chose to call, abstaining on 7%. " +
    "It is weakest on papers that are genuinely both — a new method whose point is a " +
    "biological finding.</p>" +
    "<p class='sub'>The larger caveat: this classifies the citing <em>paper</em>, not the " +
    "citation. Separating a paper that ran the model from one that name-checked it in the " +
    "introduction needs full text, which OpenAlex does not carry.</p></div>" +
    '<div class="card"><h2>The comparison record</h2>' +
    (DATA.h2h
      ? "<p>Of the " + DATA.h2h.benchmark_papers + " papers labelled <strong>benchmark</strong>, " +
        DATA.h2h.comparison_papers + " cite two or more tracked models. Those are the field " +
        "evaluating its own models against each other, and the head-to-head matrix is that " +
        "record as a grid.</p>" +
        "<p class='sub'>It is built by intersecting the citing corpus already on disk — no " +
        "extra requests — so it inherits every limit of the labels above. A cell counts " +
        "benchmarking papers citing both models; it cannot know whether the two appeared in " +
        "the same table. An empty cell means no such paper was found, which for a model " +
        "published this year is the expected state rather than a poor result.</p>"
      : "<p class='sub'>Not available on this deployment.</p>") + "</div>" +
    '<div class="card"><h2>Runnability</h2>' +
    "<p>The fifth component asks what the other four cannot: could you install " +
    "this and get it running today. Five signals — a PyPI package, a pinned " +
    "environment, a tagged release, worked examples, and an issue or discussion " +
    "resolved in the last 90 days — read from GitHub and Hugging Face and merged, " +
    "so a model is asked the same questions wherever its code lives.</p>" +
    "<p class='sub'>A package counts only when its metadata links back to the " +
    "model's own repository. PyPI's <code>uce</code>, <code>scfoundation</code> and " +
    "<code>scbert</code> all belong to unrelated projects, and name matching alone " +
    "would have credited three models with someone else's release. The two packages " +
    "that publish no link — scPRINT and arc-state — are named in the registry by hand.</p>" +
    "<p class='sub'>A signal that could not be read is dropped and the rest " +
    "renormalized, never counted as a failure. The weight came out of openness " +
    "rather than out of the citation components, so attention, momentum and usage " +
    "are weighted exactly as before.</p></div>" +
    '<div class="card"><h2>What changed, and the feed</h2>' +
    "<p>Every refresh is diffed against the one before it and written to " +
    "<code>data/changelog.json</code>, which the card on the leaderboard and " +
    "<a href='feed.xml'>feed.xml</a> both read — so the page and the feed cannot " +
    "disagree about what happened.</p>" +
    "<p class='sub'>Reported: models joining, rank moves, repositories going quiet or " +
    "being archived, licence changes, citation milestones, newly indexed benchmarking " +
    "papers, and the first time two models are jointly evaluated. A rank move has to " +
    "clear two places <em>and</em> half a score point, because neighbours a tenth of a " +
    "point apart would otherwise swap places most weeks for no reason worth reading.</p>" +
    "<p class='sub'>\"New\" means new to this tracker, not newly published: a 2024 paper " +
    "OpenAlex indexed last week is reported the week it arrives. Reviewed-preprint " +
    "versions of the same paper are collapsed by title, so a paper is announced once " +
    "rather than once per version.</p></div>" +
    '<div class="card"><h2>Data sources</h2><p class="sub">' +
    (m.sources || []).join(" · ") + ". Updated " + m.updated + ", from " + m.history_depth +
    " weekly snapshot(s).</p></div>";
}

/* ---------- routing ---------- */
function show(view, arg) {
  ["models", "landscape", "matrix", "h2h", "citations", "about", "detail"].forEach(function (v) {
    el("view-" + v).hidden = v !== view;
  });
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    var on = t.dataset.view === view;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (view === "models") renderModels();
  if (view === "landscape") renderLandscape();
  if (view === "matrix") renderMatrix();
  if (view === "h2h") renderH2H();
  if (view === "citations") renderCitations();
  if (view === "about") renderAbout();
  if (view === "detail") {
    if (el("view-detail").dataset.model !== arg) citingShown = CITING_PAGE;
    renderDetail(arg);
  }
}

document.addEventListener("click", function (e) {
  var t = e.target;
  if (t.dataset.model) { show("detail", t.dataset.model); window.scrollTo(0, 0); return; }
  if (t.dataset.dot) {
    el("tooltip").hidden = true;
    show("detail", t.dataset.dot);
    window.scrollTo(0, 0);
    return;
  }
  if (t.dataset.f) { filters[t.dataset.f] = !filters[t.dataset.f]; renderModels(); return; }
  if (t.dataset.pair) {
    // Clicking the selected cell again clears it rather than doing nothing.
    h2hPair = h2hPair === t.dataset.pair ? null : t.dataset.pair;
    el("tooltip").hidden = true;
    renderH2H();
    return;
  }
  if (t.dataset.use) { filters.use = t.dataset.use; renderCitations(); return; }
  if (t.dataset.domain) { filters.domain = t.dataset.domain; renderCitations(); return; }
  if (t.dataset.sort) {
    if (sortKey === t.dataset.sort) sortDir = -sortDir;
    else { sortKey = t.dataset.sort; sortDir = -1; }
    renderModels();
    return;
  }
  if (t.classList.contains("tab")) show(t.dataset.view);
});

document.addEventListener("input", function (e) {
  if (!e.target.dataset.w) return;
  weights[e.target.dataset.w] = Number(e.target.value) / 100;
  var focused = e.target.dataset.w, pos = e.target.value;
  renderModels();
  var again = el("w-" + focused);
  if (again) { again.value = pos; again.focus(); }
  writeHash();
});

function writeHash() {
  location.replace("#w=" + WEIGHT_KEYS.map(function (k) {
    return weights[k].toFixed(2);
  }).join(","));
}
function readHash() {
  var m = /#w=([\d.,]+)/.exec(location.hash);
  if (!m) return;
  var parts = m[1].split(",").map(Number);
  if (!parts.every(function (n) { return !isNaN(n); })) return;
  if (parts.length === WEIGHT_KEYS.length) {
    WEIGHT_KEYS.forEach(function (k, i) { weights[k] = parts[i]; });
  } else if (parts.length === LEGACY_WEIGHT_KEYS.length) {
    LEGACY_WEIGHT_KEYS.forEach(function (k, i) { weights[k] = parts[i]; });
    weights.runnable = 0;
  }
}

// Independent of the data load -- the toggle must work even if a fetch fails.
initTheme();

Promise.all(["models", "citations", "meta", "history"].map(function (f) {
  return fetch("data/" + f + ".json").then(function (r) { return r.json(); });
}).concat([
  // The only non-critical load. A deployment that predates the head-to-head
  // file should still render everything else rather than fail to paint.
  fetch("data/headtohead.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; }),
  fetch("data/changelog.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
])).then(function (res) {
  DATA.models = res[0].models;
  DATA.citations = res[1];
  DATA.meta = res[2];
  DATA.history = res[3];
  DATA.h2h = res[4];
  DATA.changelog = res[5];
  if (DATA.meta.weights) {
    WEIGHT_KEYS.forEach(function (k) { weights[k] = DATA.meta.weights[k]; });
  }
  readHash();
  el("loading").hidden = true;
  renderKpis();
  show("models");
}).catch(function (err) {
  el("loading").textContent = "Could not load data: " + err;
});
