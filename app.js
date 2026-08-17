/* Single-Cell Foundation Model Tracker — reads data/*.json, renders everything
   client-side. No build step, no dependencies. */

var DATA = {models: [], citations: {}, meta: {}, history: {snapshots: []}};
var WEIGHT_KEYS = ["attention", "momentum", "usage", "openness"];
var WEIGHT_LABELS = {
  attention: "Attention (citations)",
  momentum: "Momentum (recent gain)",
  usage: "Usage (downloads + stars)",
  openness: "Openness & upkeep"
};
var weights = {attention: 0.35, momentum: 0.25, usage: 0.20, openness: 0.20};
var sortKey = "score", sortDir = -1;
var filters = {};
var TASKS = ["annotation", "integration", "imputation", "perturbation", "grn", "spatial"];

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
  var total = WEIGHT_KEYS.reduce(function (s, k) { return s + weights[k]; }, 0) || 1;
  return WEIGHT_KEYS.reduce(function (s, k) {
    return s + (model.components[k] || 0) * (weights[k] / total);
  }, 0) * 100;
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

function deltaTag(value, unit) {
  if (value == null || value === 0) return "";
  var cls = value > 0 ? "delta-up" : "delta-down";
  return ' <span class="' + cls + '">' + (value > 0 ? "▲" : "▼") +
    Math.abs(value) + (unit || "") + "</span>";
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
    ["downloads", "HF 30d", "num"], ["stars", "Stars", "num"],
    ["days_since_push", "Upkeep", ""], ["params", "Params", "num"],
    ["cells", "Cells", "num"], ["", "Tasks", ""], ["license", "License", ""]
  ];

  el("view-models").innerHTML =
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
        '<td class="num">' + (mo.hf ? num(mo.downloads) : "—") + "</td>" +
        '<td class="num">' + (mo.github ? num(mo.stars) : "—") + deltaTag(mo.stars_delta) + "</td>" +
        '<td><span class="badge ' + mo.upkeep + '">' + mo.upkeep + "</span>" +
        (mo.days_since_push != null ? '<div class="model-org">' + mo.days_since_push + "d ago</div>" : "") +
        "</td>" +
        '<td class="num">' + compact(mo.params) + "</td>" +
        '<td class="num">' + compact(mo.cells) + "</td>" +
        '<td><div class="tasks">' + mo.tasks.map(function (t) {
          return '<span class="task-dot">' + t + "</span>";
        }).join("") + "</div></td>" +
        "<td><span class=\"sub\">" + esc(mo.license || "unstated") + "</span></td>" +
        "</tr>";
    }).join("") + "</tbody></table></div>" +
    '<p class="sub">' + rows.length + " of " + DATA.models.length +
    " models shown. Click a model name for its detail page.</p></div>";
}

/* ---------- model detail ---------- */
function renderDetail(id) {
  var mo = DATA.models.filter(function (m) { return m.id === id; })[0];
  if (!mo) return;
  var arts = DATA.citations[id] || [];
  var uses = mo.use_counts || {};

  var specs = [
    [compact(mo.params), "parameters"], [compact(mo.cells), "pretraining cells"],
    [num(mo.citations), "citations (deduped)"], [num(mo.citations_naive_sum), "naive version sum"],
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
    '<p class="sub">' + esc(mo.org) + " · " + mo.year + " · license " + esc(mo.license || "unstated") + "</p>" +
    (mo.notes ? "<p>" + esc(mo.notes) + "</p>" : "") +
    (links.length ? '<p class="sub">' + links.join(" · ") + "</p>" : "") +
    '<div class="spec-grid">' + specs.map(function (s) {
      return '<div class="spec"><b>' + esc(s[0]) + "</b><span>" + esc(s[1]) + "</span></div>";
    }).join("") + "</div></div>" +

    '<div class="card"><h2>Score breakdown</h2>' +
    WEIGHT_KEYS.map(function (k) {
      var v = mo.components[k] || 0;
      return '<div style="margin-bottom:8px"><div class="sub">' + WEIGHT_LABELS[k] +
        " — " + (v * 100).toFixed(0) + "%</div>" +
        '<div style="height:7px;background:var(--grid);border-radius:4px">' +
        '<div style="height:7px;width:' + (v * 100).toFixed(0) +
        '%;background:var(--seq-450);border-radius:4px"></div></div></div>';
    }).join("") + "</div>" +

    '<div class="card"><h2>Papers</h2>' + mo.papers.map(function (p) {
      return '<div class="art"><div class="t">' + esc(p.title) + "</div>" +
        '<div class="m">' + esc(p.venue || p.type || "") + " · " + (p.year || "") +
        " · " + num(p.cited_by_count) + " citations" +
        (p.doi ? ' · <a href="' + esc(p.doi) + '" rel="noopener">DOI</a>' : "") + "</div></div>";
    }).join("") +
    '<p class="sub">Deduped total is ' + num(mo.citations) + ", versus " +
    num(mo.citations_naive_sum) + " if versions were simply summed — the gap is papers citing more than one version.</p></div>" +

    '<div class="card"><h2>How the ' + num(mo.citations) + " citing papers use it</h2>" +
    '<p class="sub">' + ["application", "benchmark", "extension", "review"].map(function (u) {
      return '<span class="use-' + u + '">' + u + ": " + (uses[u] || 0) + "</span>";
    }).join(" · ") + "</p>" +
    "<h2>Most recent citing articles</h2>" +
    arts.map(articleRow).join("") + "</div>";

  el("back-btn").onclick = function () { show("models"); };
}

function articleRow(a) {
  return '<div class="art"><div class="t">' +
    (a.doi ? '<a href="' + esc(a.doi) + '" rel="noopener">' + esc(a.title) + "</a>" : esc(a.title)) +
    '</div><div class="m"><span class="use-' + a.use + '">' + a.use + "</span> · " +
    esc(a.first_author || "—") + (a.n_authors > 1 ? " et al." : "") +
    " · " + esc(a.venue || "unlisted") + " · " + (a.date || a.year || "") + "</div></div>";
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
  var shown = all.filter(function (a) { return useFilter === "all" || a.use === useFilter; });

  el("view-citations").innerHTML =
    '<div class="card"><h2>What is citing these models</h2>' +
    '<p class="sub">Every citing paper is labelled by how it uses the model, from its title. ' +
    '<strong>Benchmark</strong> papers are the ones that evaluated a model rather than applied it — ' +
    'that is where critical findings live.</p>' +
    '<div class="filters">' + ["all", "application", "benchmark", "extension", "review"].map(function (u) {
      return '<button class="chip' + (useFilter === u ? " on" : "") + '" data-use="' + u + '">' + u + "</button>";
    }).join("") + "</div></div>" +
    '<div class="card">' + shown.slice(0, 300).map(function (a) {
      return '<div class="art"><div class="t">' +
        (a.doi ? '<a href="' + esc(a.doi) + '" rel="noopener">' + esc(a.title) + "</a>" : esc(a.title)) +
        '</div><div class="m">cites <strong>' + esc(a.model) + '</strong> · <span class="use-' +
        a.use + '">' + a.use + "</span> · " + esc(a.venue || "unlisted") +
        " · " + (a.date || a.year || "") + "</div></div>";
    }).join("") +
    '<p class="sub">Showing ' + Math.min(300, shown.length) + " of " + shown.length +
    " recent citing articles (most recent " + DATA.meta.models_tracked + " per model retained).</p></div>";
}

/* ---------- about ---------- */
function renderAbout() {
  var m = DATA.meta;
  el("about-dynamic").innerHTML =
    '<div class="card"><h2>How the score works</h2>' +
    "<p>Each model is scored 0–100 from four normalized components, weighted by default as " +
    WEIGHT_KEYS.map(function (k) {
      return Math.round((m.weights ? m.weights[k] : weights[k]) * 100) + "% " + WEIGHT_LABELS[k].toLowerCase();
    }).join(", ") + ". The leaderboard sliders re-weight everything live.</p>" +
    "<ul><li><strong>Attention</strong> — log-scaled total citations, deduplicated across every " +
    "version of the model paper.</li>" +
    "<li><strong>Momentum</strong> — citations gained recently. Currently derived from " +
    esc(m.momentum_basis) + "; once enough weekly snapshots accumulate this switches to a measured delta.</li>" +
    "<li><strong>Usage</strong> — Hugging Face downloads plus GitHub stars. Absent Hugging Face " +
    "numbers mean weights are distributed elsewhere, not that nobody uses the model.</li>" +
    "<li><strong>Openness &amp; upkeep</strong> — open weights, license permissiveness, and days " +
    "since the last commit.</li></ul>" +
    "<p class='sub'>Deduplication matters: a review citing both the bioRxiv and the journal version " +
    "of a model paper counts once. Summing versions instead would inflate the best-known models most.</p></div>" +
    '<div class="card"><h2>Data sources</h2><p class="sub">' +
    (m.sources || []).join(" · ") + ". Updated " + m.updated + ", from " + m.history_depth +
    " weekly snapshot(s).</p></div>";
}

/* ---------- routing ---------- */
function show(view, arg) {
  ["models", "citations", "about", "detail"].forEach(function (v) {
    el("view-" + v).hidden = v !== view;
  });
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    var on = t.dataset.view === view;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (view === "models") renderModels();
  if (view === "citations") renderCitations();
  if (view === "about") renderAbout();
  if (view === "detail") renderDetail(arg);
}

document.addEventListener("click", function (e) {
  var t = e.target;
  if (t.dataset.model) { show("detail", t.dataset.model); window.scrollTo(0, 0); return; }
  if (t.dataset.f) { filters[t.dataset.f] = !filters[t.dataset.f]; renderModels(); return; }
  if (t.dataset.use) { filters.use = t.dataset.use; renderCitations(); return; }
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
  if (parts.length === WEIGHT_KEYS.length && parts.every(function (n) { return !isNaN(n); })) {
    WEIGHT_KEYS.forEach(function (k, i) { weights[k] = parts[i]; });
  }
}

Promise.all(["models", "citations", "meta", "history"].map(function (f) {
  return fetch("data/" + f + ".json").then(function (r) { return r.json(); });
})).then(function (res) {
  DATA.models = res[0].models;
  DATA.citations = res[1];
  DATA.meta = res[2];
  DATA.history = res[3];
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
