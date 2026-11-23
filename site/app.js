/* AI in education on Bluesky - explorer.
 * Every view is filtered by every control except its own, so each chart shows
 * the distribution you could still narrow down to. All data strings are set
 * with textContent (d3 .text), never as HTML. */
(function () {
  "use strict";

  const fmtInt = d3.format(",");
  const fmtPct = d3.format(".0%");
  const fmtScore = d3.format("+.2f");
  const fmtWeek = d3.utcFormat("%b %-d, %Y");
  const fmtShort = d3.utcFormat("%b %-d");
  const parseDay = d3.utcParse("%Y-%m-%d");
  const EXCERPTS_SHOWN = 24;
  const BAND_LABEL = { neg: "Negative", neu: "Neutral", pos: "Positive" };

  const $ = (id) => document.getElementById(id);
  const tooltip = $("tooltip");

  let data, posts, weeks, cutoff;
  const state = { theme: "all", band: "all", reply: "all", k: 1, topic: null, range: null, q: "" };

  // ---------- loading ----------
  fetch("data/data.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(init)
    .catch(() => { $("empty").hidden = false; });

  function init(d) {
    data = d;
    cutoff = d.meta.vader_cutoff;
    posts = d.posts.map((p) => ({
      ...p,
      week: p.w,
      band: p.s <= -cutoff ? "neg" : p.s >= cutoff ? "pos" : "neu",
      lx: p.x ? p.x.toLowerCase() : "",
    }));
    // Every Monday in the window, including weeks with no sampled posts.
    const first = d3.utcMonday.floor(parseDay(d.meta.window_start));
    const last = d3.utcDay.offset(parseDay(d.meta.window_end), -1);
    weeks = d3.utcMonday.range(first, d3.utcDay.offset(last, 1)).map((w) => w.toISOString().slice(0, 10));
    state.k = Math.max(0, d.meta.topic_counts.indexOf(8));

    $("lede").textContent =
      `An explorer for ${fmtInt(posts.length)} English-language Bluesky posts from ` +
      `${fmtWeek(parseDay(d.meta.window_start))} to ${fmtWeek(last)} about AI detectors, ` +
      `students cheating with AI, and how teachers respond.`;

    const themeSel = d3.select("#f-theme");
    themeSel.append("option").attr("value", "all").text("All themes");
    d.meta.themes.forEach((t) => themeSel.append("option").attr("value", t.key).text(t.label));
    themeSel.append("option").attr("value", "none").text("None of these");
    const kSel = d3.select("#f-k");
    d.meta.topic_counts.forEach((k, i) => kSel.append("option").attr("value", i).text(`${k} groups`));
    $("f-k").value = String(state.k);

    bindControls();
    buildTimeline();
    renderMethods();
    $("app").hidden = false;
    update(true);
    new ResizeObserver(debounce(() => { buildTimeline(); update(false); }, 150)).observe($("timeline"));
  }

  // ---------- filtering ----------
  function passes(p, skip) {
    if (skip !== "theme" && state.theme !== "all") {
      if (state.theme === "none" ? p.th.length : !p.th.includes(state.theme)) return false;
    }
    if (skip !== "band" && state.band !== "all" && p.band !== state.band) return false;
    if (skip !== "reply" && state.reply !== "all" && (state.reply === "reply") !== (p.r === 1)) return false;
    if (skip !== "topic" && state.topic !== null && p.t[state.k] !== state.topic) return false;
    if (skip !== "range" && state.range && (p.week < state.range[0] || p.week > state.range[1])) return false;
    if (skip !== "q" && state.q && !p.lx.includes(state.q)) return false;
    return true;
  }

  function bindControls() {
    const on = (id, key, cast = (v) => v) =>
      $(id).addEventListener("change", (e) => { state[key] = cast(e.target.value); update(true); });
    on("f-theme", "theme");
    on("f-band", "band");
    on("f-reply", "reply");
    $("f-k").addEventListener("change", (e) => { state.k = +e.target.value; state.topic = null; update(true); });
    $("f-q").addEventListener("input", debounce((e) => { state.q = e.target.value.trim().toLowerCase(); update(true); }, 200));
    $("reset").addEventListener("click", () => {
      Object.assign(state, { theme: "all", band: "all", reply: "all", topic: null, range: null, q: "" });
      $("f-theme").value = "all"; $("f-band").value = "all"; $("f-reply").value = "all"; $("f-q").value = "";
      setBrush(null);
      update(true);
    });
    $("clear-range").addEventListener("click", () => { state.range = null; setBrush(null); update(true); });
    $("shuffle").addEventListener("click", renderExcerpts);
  }

  function update(resample) {
    const matching = posts.filter((p) => passes(p));
    renderStatus(matching);
    renderTimeline();
    renderThemes();
    renderSentiment();
    renderTopics();
    if (resample) renderExcerpts();
    $("clear-range").hidden = !state.range;
    $("f-band").value = state.band;
    $("f-theme").value = state.theme;
  }

  function renderStatus(matching) {
    const parts = [`Showing ${fmtInt(matching.length)} of ${fmtInt(posts.length)} posts`];
    if (state.range) parts.push(`weeks of ${fmtShort(parseDay(state.range[0]))} – ${fmtWeek(parseDay(state.range[1]))}`);
    if (state.topic !== null) parts.push(`word group ${state.topic + 1}`);
    $("status").textContent = parts.join(" · ");
  }

  // ---------- tooltip ----------
  function showTip(event, rows) {
    tooltip.replaceChildren();
    rows.forEach(([value, label]) => {
      const div = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = value;
      const span = document.createElement("span");
      span.className = "k";
      span.textContent = " " + label;
      div.append(strong, span);
      tooltip.append(div);
    });
    tooltip.hidden = false;
    const pad = 14, w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  const hideTip = () => { tooltip.hidden = true; };

  // Column with a 4px rounded top, square at the baseline.
  function colPath(x, y, w, h) {
    if (h <= 0) return "";
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ---------- timeline ----------
  let tl; // {svg, x, y, gAll, gMatch, brush, gBrush, height, margin}

  function buildTimeline() {
    const el = $("timeline");
    const width = el.clientWidth || 800;
    const margin = { top: 8, right: 8, bottom: 24, left: 36 };
    const height = 200;
    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]).attr("height", height)
      .attr("role", "img").attr("aria-label", "Column chart of sampled posts per week; details in the table below.");
    const x = d3.scaleBand().domain(weeks).range([margin.left, width - margin.right]).paddingInner(0.15);
    const y = d3.scaleLinear().range([height - margin.bottom, margin.top]);
    const gGrid = svg.append("g").attr("class", "gridline").attr("transform", `translate(${margin.left},0)`);
    const gAll = svg.append("g");
    const gMatch = svg.append("g");
    const gAxisX = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`);
    // One tick per month, at least 3 weeks apart (wider gaps on phones); the year shows on the first tick and in January.
    const minGap = width < 600 ? 12 : 3;
    const months = [];
    weeks.forEach((w, i) => {
      if (i > 0 && w.slice(0, 7) === weeks[i - 1].slice(0, 7)) return;
      if (months.length && i - weeks.indexOf(months[months.length - 1]) < minGap) return;
      months.push(w);
    });
    gAxisX.call(d3.axisBottom(x).tickValues(months).tickSize(0).tickPadding(8)
      .tickFormat((w, i) => d3.utcFormat(i === 0 || w.slice(5, 7) === "01" ? "%b %Y" : "%b")(parseDay(w))));
    gAxisX.select(".domain").attr("stroke", "var(--axis)");

    const brush = d3.brushX().extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]])
      .on("end", (event) => {
        if (!event.sourceEvent) return; // programmatic move
        if (!event.selection) { state.range = null; update(true); return; }
        const [a, b] = event.selection;
        const picked = weeks.filter((w) => { const c = x(w) + x.bandwidth() / 2; return c >= a && c <= b; });
        state.range = picked.length ? [picked[0], picked[picked.length - 1]] : null;
        setBrush(state.range);
        update(true);
      });
    const gBrush = svg.append("g").attr("class", "brush").call(brush);

    svg.on("pointermove", (event) => {
      const [px] = d3.pointer(event);
      const step = x.step();
      const i = Math.floor((px - margin.left + (step - x.bandwidth()) / 2) / step);
      const w = weeks[i];
      if (!w) return hideTip();
      const total = posts.filter((p) => p.week === w).length;
      const match = posts.filter((p) => p.week === w && passes(p, "range")).length;
      showTip(event, [[`Week of ${fmtWeek(parseDay(w))}`, ""], [fmtInt(match), "matching"], [fmtInt(total), "in sample"]]);
    }).on("pointerleave", hideTip);

    tl = { svg, x, y, gGrid, gAll, gMatch, brush, gBrush, height, margin };
    setBrush(state.range);
  }

  function setBrush(range) {
    if (!tl) return;
    if (!range) return tl.gBrush.call(tl.brush.move, null);
    const { x } = tl;
    tl.gBrush.call(tl.brush.move, [x(range[0]), x(range[1]) + x.bandwidth()]);
  }

  function renderTimeline() {
    const { x, y, gGrid, gAll, gMatch, height, margin } = tl;
    const all = d3.rollup(posts, (v) => v.length, (p) => p.week);
    const match = d3.rollup(posts.filter((p) => passes(p, "range")), (v) => v.length, (p) => p.week);
    y.domain([0, d3.max(weeks, (w) => all.get(w) || 0) || 1]).nice();
    gGrid.call(d3.axisLeft(y).ticks(4).tickSize(-(x.range()[1] - margin.left)).tickFormat(fmtInt))
      .call((g) => g.selectAll("text").attr("fill", "var(--muted)").attr("font-size", 11));
    gGrid.attr("class", "gridline axis");
    const bw = Math.min(24, x.bandwidth());
    const off = (x.bandwidth() - bw) / 2;
    const draw = (g, map, fill) => g.selectAll("path").data(weeks).join("path")
      .attr("fill", fill)
      .attr("d", (w) => {
        const v = map.get(w) || 0;
        return colPath(x(w) + off, y(v), bw, y(0) - y(v));
      });
    draw(gAll, all, "var(--bg-bar)");
    draw(gMatch, match, "var(--accent)");

    const rows = weeks.map((w) => [fmtWeek(parseDay(w)), match.get(w) || 0, all.get(w) || 0]);
    table($("timeline-table"), ["Week of", "Matching", "In sample"], rows);
  }

  // ---------- sentiment ----------
  // 21 bins: ten negative, one neutral (−cutoff..+cutoff), ten positive.
  function sentimentBins() {
    const neg = d3.range(11).map((i) => -1 + i * (1 - cutoff) / 10);
    const pos = neg.map((v) => -v).reverse();
    const edges = [...neg, ...pos];
    return d3.range(edges.length - 1).map((i) => ({
      x0: edges[i], x1: edges[i + 1],
      band: i < 10 ? "neg" : i === 10 ? "neu" : "pos",
    }));
  }
  function binIndex(p, bins) {
    if (p.band === "neu") return 10;
    const [lo, hi] = p.band === "neg" ? [0, 9] : [11, 20];
    for (let i = lo; i < hi; i++) if (p.s < bins[i].x1) return i;
    return hi;
  }

  function renderSentiment() {
    const el = $("sentiment");
    const width = el.clientWidth || 500;
    const height = 200;
    const margin = { top: 8, right: 8, bottom: 24, left: 36 };
    const bins = sentimentBins();
    const all = new Array(bins.length).fill(0);
    const match = new Array(bins.length).fill(0);
    posts.forEach((p) => {
      const i = binIndex(p, bins);
      all[i]++;
      if (passes(p, "band")) match[i]++;
    });
    const x = d3.scaleLinear().domain([-1, 1]).range([margin.left, width - margin.right]);
    const y = d3.scaleLinear().domain([0, d3.max(all) || 1]).nice().range([height - margin.bottom, margin.top]);

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]).attr("height", height)
      .attr("role", "img").attr("aria-label", "Histogram of tone scores from −1 to +1; details in the table below.");
    svg.append("g").attr("class", "gridline axis").attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-(width - margin.left - margin.right)).tickFormat(fmtInt));
    const gx = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).tickValues([-1, -0.5, 0, 0.5, 1]).tickSize(0).tickPadding(8).tickFormat(d3.format("+.1~f")));
    gx.select(".domain").attr("stroke", "var(--axis)");

    const colw = (b) => Math.max(1, x(b.x1) - x(b.x0) - 2);
    const g = svg.selectAll("g.bin").data(bins).join("g").attr("class", "bin")
      .style("cursor", "pointer")
      .attr("opacity", (b) => (state.band === "all" || state.band === b.band ? 1 : 0.35));
    g.append("rect").attr("x", (b) => x(b.x0)).attr("y", margin.top).attr("width", (b) => x(b.x1) - x(b.x0))
      .attr("height", height - margin.top - margin.bottom).attr("fill", "transparent");
    g.append("path").attr("fill", "var(--bg-bar)")
      .attr("d", (b, i) => colPath(x(b.x0) + 1, y(all[i]), colw(b), y(0) - y(all[i])));
    g.append("path").attr("fill", (b) => `var(--${b.band})`)
      .attr("d", (b, i) => colPath(x(b.x0) + 1, y(match[i]), colw(b), y(0) - y(match[i])));
    g.on("pointermove", (event, b) => {
      const i = bins.indexOf(b);
      showTip(event, [[`${fmtScore(b.x0)} to ${fmtScore(b.x1)}`, BAND_LABEL[b.band]], [fmtInt(match[i]), "matching"], [fmtInt(all[i]), "in sample"]]);
    }).on("pointerleave", hideTip)
      .on("click", (event, b) => { state.band = state.band === b.band ? "all" : b.band; update(true); });

    const rows = bins.map((b, i) => [`${fmtScore(b.x0)} to ${fmtScore(b.x1)}`, BAND_LABEL[b.band], match[i], all[i]]);
    table($("sentiment-table"), ["Tone score", "Tone", "Matching", "In sample"], rows);
  }

  // ---------- themes ----------
  // Plain-language summary of each theme's keywords (the exact patterns are in the methods section).
  const THEME_HINT = {
    detectors: "mentions Turnitin, GPTZero, AI detectors, or posts being flagged",
    cheating: "mentions cheating, plagiarism or academic integrity",
    teachers: "mentions teachers or professors, class AI policies, blue books, handwritten or oral exams",
    none: "mentions AI and education, but none of the keywords above",
  };

  function renderThemes() {
    const items = data.meta.themes.map((t) => ({ key: t.key, label: t.label }))
      .concat([{ key: "none", label: "None of these themes" }]);
    const has = (p, key) => (key === "none" ? p.th.length === 0 : p.th.includes(key));
    const matching = posts.filter((p) => passes(p, "theme"));
    const all = new Map(items.map((t) => [t.key, posts.filter((p) => has(p, t.key)).length]));
    const match = new Map(items.map((t) => [t.key, matching.filter((p) => has(p, t.key)).length]));
    const max = d3.max(all.values()) || 1;

    const rows = d3.select("#themes").selectAll("button.topic").data(items, (t) => t.key).join((enter) => {
      const b = enter.append("button").attr("type", "button").attr("class", "topic");
      const head = b.append("span").attr("class", "topic-head");
      head.append("span").attr("class", "topic-name");
      head.append("span").attr("class", "topic-count");
      b.append("span").attr("class", "topic-words");
      const bar = b.append("span").attr("class", "topic-bar");
      bar.append("i").attr("class", "all");
      bar.append("i").attr("class", "match");
      return b;
    });
    rows.classed("active", (t) => state.theme === t.key)
      .classed("dim", (t) => state.theme !== "all" && state.theme !== t.key)
      .attr("aria-pressed", (t) => state.theme === t.key)
      .on("click", (event, t) => { state.theme = state.theme === t.key ? "all" : t.key; update(true); });
    rows.select(".topic-name").text((t) => t.label);
    rows.select(".topic-count").text((t) => `${fmtInt(match.get(t.key))} matching · ${fmtInt(all.get(t.key))} in sample`);
    rows.select(".topic-words").text((t) => THEME_HINT[t.key] || "");
    rows.select(".all").style("width", (t) => `${(all.get(t.key) / max) * 100}%`);
    rows.select(".match").style("width", (t) => `${(match.get(t.key) / max) * 100}%`);
  }

  // ---------- topics ----------
  function renderTopics() {
    const k = data.meta.topic_counts[state.k];
    const topics = data.topics[String(k)];
    $("topics-title").textContent = `Word groups (${k} groups)`;
    const all = d3.rollup(posts, (v) => v.length, (p) => p.t[state.k]);
    const match = d3.rollup(posts.filter((p) => passes(p, "topic")), (v) => v.length, (p) => p.t[state.k]);
    const nMatch = d3.sum(match.values());
    const max = d3.max(topics, (t) => all.get(t.id) || 0) || 1;

    const rows = d3.select("#topics").selectAll("button.topic").data(topics, (t) => t.id).join((enter) => {
      const b = enter.append("button").attr("type", "button").attr("class", "topic");
      const head = b.append("span").attr("class", "topic-head");
      head.append("span").attr("class", "topic-name");
      head.append("span").attr("class", "topic-count");
      b.append("span").attr("class", "topic-words");
      const bar = b.append("span").attr("class", "topic-bar");
      bar.append("i").attr("class", "all");
      bar.append("i").attr("class", "match");
      return b;
    });
    rows.classed("active", (t) => state.topic === t.id)
      .classed("dim", (t) => state.topic !== null && state.topic !== t.id)
      .attr("aria-pressed", (t) => state.topic === t.id)
      .on("click", (event, t) => { state.topic = state.topic === t.id ? null : t.id; update(true); });
    rows.select(".topic-name").text((t) => `Group ${t.id + 1}`);
    rows.select(".topic-count").text((t) => {
      const m = match.get(t.id) || 0;
      return `${fmtInt(m)} matching (${nMatch ? fmtPct(m / nMatch) : "0%"}) · ${fmtInt(all.get(t.id) || 0)} in sample`;
    });
    rows.select(".topic-words").text((t) => t.words.join(", "));
    rows.select(".all").style("width", (t) => `${((all.get(t.id) || 0) / max) * 100}%`);
    rows.select(".match").style("width", (t) => `${((match.get(t.id) || 0) / max) * 100}%`);
  }

  // ---------- excerpts ----------
  function renderExcerpts() {
    const matching = posts.filter((p) => passes(p));
    const withText = matching.filter((p) => p.x);
    const shown = d3.shuffle(withText.slice()).slice(0, window.innerWidth < 600 ? 8 : EXCERPTS_SHOWN);
    const short = matching.length - withText.length;
    $("excerpt-sub").textContent =
      `${fmtInt(shown.length)} random excerpts from ${fmtInt(matching.length)} matching posts` +
      (short ? ` (${fmtInt(short)} too short to excerpt)` : "") + ". Shuffle for a different set.";
    const themeLabel = Object.fromEntries(data.meta.themes.map((t) => [t.key, t.label]));
    const li = d3.select("#excerpts").selectAll("li").data(shown).join((enter) => {
      const l = enter.append("li");
      l.append("q");
      l.append("div").attr("class", "meta");
      return l;
    });
    li.select("q").text((p) => p.x);
    li.select(".meta").each(function (p) {
      const m = d3.select(this);
      m.selectAll("*").remove();
      m.append("span").text(`Week of ${fmtShort(parseDay(p.week))}`);
      m.append("span").text(p.r ? "Reply" : "Post");
      m.append("span").text(p.t[state.k] >= 0 ? `Word group ${p.t[state.k] + 1}` : "No word group");
      m.append("span").text(`Tone ${fmtScore(p.s)}`);
      p.th.forEach((t) => m.append("span").attr("class", "tag").text(themeLabel[t]));
    });
  }

  // ---------- methods ----------
  function renderMethods() {
    const m = data.meta;
    const fc = m.filter_counts;
    const root = d3.select("#methods-body");
    root.selectAll("*").remove();
    const h = (t) => root.append("h3").text(t);
    const p = (t) => root.append("p").text(t);
    const list = (items) => { const ul = root.append("ul"); items.forEach((t) => ul.append("li").text(t)); return ul; };
    const codeList = (items) => {
      const ul = root.append("ul");
      items.forEach(([label, code]) => { const li = ul.append("li"); li.append("span").text(label + ": "); li.append("code").text(code); });
    };

    h("What was collected");
    p(`Posts were collected once, on ${m.collected_at}, through Bluesky's search API (searchPosts, English, newest first). ` +
      `The 52 weeks from ${m.window_start} to ${m.window_end} were searched one week at a time. ` +
      `Each search term contributed at most its 100 most recent posts per week. In weeks when a term matched more than 100 posts, ` +
      `only the latest ones were seen, so each week's sample leans toward the last days of that week.`);
    p("Search terms:");
    root.append("p").append("code").text(m.queries.join("   "));
    p(`Of ${fmtInt(fc.seen)} posts returned: ${fmtInt(fc.opted_out)} were skipped because their authors ask not to be shown to ` +
      `logged-out viewers, ${fmtInt(fc.non_english)} were not tagged English, and ${fmtInt(fc.irrelevant)} failed the relevance ` +
      `filter. That left ${fmtInt(m.relevant_found)} relevant posts. From these, ${fmtInt(m.n_posts)} were drawn at random, ` +
      `with about the same number from each week. So the weekly chart shows how the sample was spread over time, not how much people posted.`);
    p("A post counts as relevant only if it contains an AI term and an education term:");
    codeList([["AI terms", m.relevance.ai], ["Education terms", m.relevance.edu]]);

    h("Themes");
    p("Themes come from the words in each post, not from the search term that found it. A post can belong to several themes or to none.");
    codeList(m.themes.map((t) => [t.label, t.pattern]));

    h("Tone of voice (sentiment)");
    p(`The tone score comes from VADER, a word-list sentiment scorer built for social media. It scored the full text of each post (with mentions and links removed). ` +
      `Scores of −${cutoff} or lower count as negative, +${cutoff} or higher as positive, and anything between as neutral. ` +
      `VADER misreads sarcasm, and it rates words like “cheating”, “plagiarism” or “false” as negative even when a post is calm ` +
      `or approving. It measures the tone of the wording, not the writer's opinion, so read it as a rough sorting aid. The score is for the whole post, ` +
      `so it can differ from the tone of the excerpt you see.`);

    h("Word groups (topics)");
    p(`LDA (latent Dirichlet allocation, from scikit-learn) was fit three times, with ${m.topic_counts.join(", ")} topics, ` +
      `on word counts (${fmtInt(m.vocab_size)} distinct words). Common English words were removed first, along with generic words like ` +
      `“ai” and “chatgpt” that appear in nearly every post. Each post is assigned to its single most likely topic, shown on this page as a numbered word group. ` +
      `A topic is a statistical cluster of words that tend to occur together. It is not necessarily a subject people would recognise, ` +
      `and changing the number of topics reshuffles them. LDA is designed for long documents and is unreliable on short posts. ` +
      `Topics are numbered, not named, so that interpreting them stays with you.`);

    h("Privacy");
    list([
      "No usernames, display names, account IDs or links to posts were stored or published.",
      "@mentions inside the text were replaced with [user], links with [link], and email addresses with [email].",
      `Only excerpts are shown: at most ${m.excerpt_chars} characters and never more than ${fmtPct(m.excerpt_max_share)} of a post. ` +
        `Posts too short for an excerpt of ${m.excerpt_min_chars} characters show no text.`,
      "Dates are rounded to the week, and posts are stored in random order.",
      "Full post text existed only on the temporary GitHub Actions machine during the single collection run, and was never saved to the repository.",
      "An excerpt is still verbatim text and could be found again with Bluesky's search. Please don't try to identify the people behind these posts.",
    ]);

    h("What this can't tell you");
    list([
      "Who is posting: teachers, students, parents and journalists are not told apart.",
      "Whether Bluesky users are representative of anyone else.",
      "How much people posted about this over time, because each week was sampled to the same size.",
      "Anything about posts the search terms missed, or posts that were deleted before collection.",
    ]);
  }

  // ---------- helpers ----------
  function table(el, headers, rows) {
    const t = d3.select(el).selectAll("table").data([0]).join("table");
    t.selectAll("thead").data([0]).join("thead").selectAll("tr").data([headers]).join("tr")
      .selectAll("th").data((d) => d).join("th").attr("class", (d, i) => (i >= headers.length - 2 ? "num" : null)).text((d) => d);
    t.selectAll("tbody").data([0]).join("tbody").selectAll("tr").data(rows).join("tr")
      .selectAll("td").data((d) => d).join("td")
      .attr("class", (d) => (typeof d === "number" ? "num" : null))
      .text((d) => (typeof d === "number" ? fmtInt(d) : d));
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
})();
