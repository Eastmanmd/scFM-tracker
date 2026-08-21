/* Single-Cell Foundation Model Tracker — reads data/*.json, renders everything
   client-side. No build step, no dependencies. */

var DATA = {models: [], citations: {}, meta: {}, history: {snapshots: []}};

/* data/citations.json carries only the most recent few articles per model so the
   first paint stays small. A model's complete citing list lives in its own file
   and is pulled the first time its page is opened, then kept for the session.
   citingFull[id] is undefined until fetched, null while in flight, and false if
   the fetch failed -- so a failure falls back to the index instead of retrying
   on every re-render. */
var citingFull = {};
var CITING_PAGE = 100;   // rows revealed per "show more" click
var citingShown = CITING_PAGE;
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
        '<td class="num">' + bioShareCell(mo) + "</td>" +
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
        "<td>" + licenseCell(mo.license) + "</td>" +
        "</tr>";
    }).join("") + "</tbody></table></div>" +
    '<p class="sub">' + rows.length + " of " + DATA.models.length +
    " models shown. Click a model name for its detail page.</p></div>";
}

/* Share of a model's classified citations that are biology work, rendered as a
   bar. Deliberately not coloured as good or bad: a low number can mean the
   model is a methods plaything, or simply that biologists cite the tool paper
   less than tool-builders do. The page states the ambiguity rather than
   resolving it with a colour. */
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
  if (e.target.dataset && e.target.dataset.dot) el("tooltip").hidden = true;
});

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
    '<div class="card"><h2>Data sources</h2><p class="sub">' +
    (m.sources || []).join(" · ") + ". Updated " + m.updated + ", from " + m.history_depth +
    " weekly snapshot(s).</p></div>";
}

/* ---------- routing ---------- */
function show(view, arg) {
  ["models", "landscape", "matrix", "citations", "about", "detail"].forEach(function (v) {
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
  if (parts.length === WEIGHT_KEYS.length && parts.every(function (n) { return !isNaN(n); })) {
    WEIGHT_KEYS.forEach(function (k, i) { weights[k] = parts[i]; });
  }
}

// Independent of the data load -- the toggle must work even if a fetch fails.
initTheme();

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
