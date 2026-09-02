/* =========================================================
   analytics.js — read-only completed-project figures
   ========================================================= */

let scope = "month";
let year = new Date().getFullYear();
let month = new Date().getMonth() + 1;

async function loadAnalytics() {
  const params = new URLSearchParams({ scope, year: String(year) });
  if (scope === "month") params.set("month", String(month));

  try {
    const data = await apiGet(`/api/analytics?${params.toString()}`);
    render(data);
  } catch (e) {
    console.error(e);
  }
}

function render(data) {
  document.getElementById("periodLabel").textContent = data.periodLabel;
  document.getElementById("chartTitle").textContent =
    scope === "month" ? "Value — last 12 months" : "Value — last 5 years";

  animateNumber(document.getElementById("numValue"), data.totalValue, formatCurrency);
  animateNumber(document.getElementById("numCount"), data.completedCount, (n) => String(Math.round(n)));
  animateRing(data.onTimePercent);
  animateNumber(document.getElementById("numPercent"), data.onTimePercent, (n) => Math.round(n) + "%");

  renderBarChart(data.series);
}

/* ---------------------------------------------------------
   Animated count-up numbers
   --------------------------------------------------------- */
function animateNumber(el, target, formatter) {
  const start = Number(el.dataset.raw || 0);
  const duration = 700;
  const startTime = performance.now();

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = start + (target - start) * eased;
    el.textContent = formatter(value);
    if (t < 1) requestAnimationFrame(step);
    else el.dataset.raw = target;
  }
  requestAnimationFrame(step);
}

function animateRing(percent) {
  const circle = document.getElementById("ringFg");
  const r = 52;
  const circumference = 2 * Math.PI * r;
  circle.style.strokeDasharray = `${circumference}`;
  const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
  // force reflow so the transition plays
  circle.style.transition = "none";
  circle.style.strokeDashoffset = circumference;
  circle.getBoundingClientRect();
  circle.style.transition = "stroke-dashoffset 0.8s cubic-bezier(.22,.68,0,1.01)";
  circle.style.strokeDashoffset = offset;
}

/* ---------------------------------------------------------
   Bar chart
   --------------------------------------------------------- */
function renderBarChart(series) {
  const wrap = document.getElementById("barChart");
  wrap.innerHTML = "";
  const max = Math.max(1, ...series.map((s) => s.value));

  series.forEach((s) => {
    const col = document.createElement("div");
    col.className = "bar-col";
    const pct = Math.round((s.value / max) * 100);
    col.innerHTML = `
      <div class="bar-value">${s.value ? formatCurrency(s.value) : ""}</div>
      <div class="bar-track"><div class="bar-fill" style="height:0%" data-target="${pct}"></div></div>
      <div class="bar-label">${escapeHtml(s.label)}</div>
    `;
    wrap.appendChild(col);
  });

  requestAnimationFrame(() => {
    wrap.querySelectorAll(".bar-fill").forEach((el) => {
      el.style.height = el.dataset.target + "%";
    });
  });
}

/* ---------------------------------------------------------
   Controls
   --------------------------------------------------------- */
document.querySelectorAll(".segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".segmented-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    scope = btn.dataset.scope;
    loadAnalytics();
  });
});

document.getElementById("btnPrev").addEventListener("click", () => {
  if (scope === "month") {
    month--;
    if (month < 1) { month = 12; year--; }
  } else {
    year--;
  }
  loadAnalytics();
});

document.getElementById("btnNext").addEventListener("click", () => {
  if (scope === "month") {
    month++;
    if (month > 12) { month = 1; year++; }
  } else {
    year++;
  }
  loadAnalytics();
});

/* ---------------------------------------------------------
   Reusable multi-series line chart (used by both the Task
   Count chart and the KPI chart below)
   --------------------------------------------------------- */
const STAGE_KEYS = Object.keys(STAGE_DURATIONS).filter((s) => s !== "Not Selected");
const TOTAL_COLOR = "#0F1B2D";

function computeNiceMax(maxVal) {
  if (maxVal <= 0) return 4;
  const rough = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm <= 1) step = 1 * mag;
  else if (norm <= 2) step = 2 * mag;
  else if (norm <= 5) step = 5 * mag;
  else step = 10 * mag;
  return step * 4;
}

function renderToggles(containerEl, visibleSet, getShowTotal, setShowTotal, onChange) {
  containerEl.innerHTML = `
    <label class="stage-toggle-row total-toggle-row">
      <span class="total-swatch"></span>
      <span class="stage-toggle-label">Total</span>
      <span class="switch switch-total">
        <input type="checkbox" data-total="1" ${getShowTotal() ? "checked" : ""}>
        <span class="switch-slider"></span>
      </span>
    </label>
    <div class="toggle-divider"></div>
    ${STAGE_KEYS.map((stage) => {
      const color = STAGE_LINE_COLORS[stage];
      const checked = visibleSet.has(stage) ? "checked" : "";
      return `
        <label class="stage-toggle-row">
          <span class="stage-toggle-dot" style="background:${color}"></span>
          <span class="stage-toggle-label">${escapeHtml(stage)}</span>
          <span class="switch">
            <input type="checkbox" data-stage="${escapeHtml(stage)}" ${checked}>
            <span class="switch-slider" style="--on-color:${color}"></span>
          </span>
        </label>`;
    }).join("")}
  `;

  containerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.dataset.total) {
        setShowTotal(cb.checked);
      } else {
        const stage = cb.dataset.stage;
        if (cb.checked) visibleSet.add(stage);
        else visibleSet.delete(stage);
      }
      onChange();
    });
  });
}

function renderLineChart(svg, { labels, series, total, visibleSet, showTotal, valueKey, yMax, yFormat }) {
  if (!labels) { svg.innerHTML = ""; return; }

  const W = 900, H = 320, ML = 52, MR = 14, MT = 16, MB = 50;
  const PW = W - ML - MR, PH = H - MT - MB;
  const N = labels.length;
  const xAt = (i) => (N <= 1 ? ML + PW / 2 : ML + (i / (N - 1)) * PW);
  const yAt = (v) => MT + (1 - v / yMax) * PH;

  let out = "";

  for (let t = 0; t <= 4; t++) {
    const v = (yMax / 4) * t;
    const y = yAt(v);
    out += `<line x1="${ML}" y1="${y}" x2="${ML + PW}" y2="${y}" class="grid-line"/>`;
    out += `<text x="${ML - 10}" y="${y + 4}" class="axis-label axis-label-y" text-anchor="end">${yFormat(v)}</text>`;
  }

  labels.forEach((lab, i) => {
    const x = xAt(i);
    if (N > 12) {
      out += `<text x="${x}" y="${MT + PH + 16}" class="axis-label" text-anchor="end" transform="rotate(-45 ${x} ${MT + PH + 16})">${escapeHtml(lab)}</text>`;
    } else {
      out += `<text x="${x}" y="${MT + PH + 24}" class="axis-label" text-anchor="middle">${escapeHtml(lab)}</text>`;
    }
  });

  function drawSeries(points, color, widthPx) {
    const segments = [];
    let current = [];
    points.forEach((p, i) => {
      const val = p ? p[valueKey] : null;
      if (val === null || val === undefined) {
        if (current.length) { segments.push(current); current = []; }
      } else {
        current.push([xAt(i), yAt(val)]);
      }
    });
    if (current.length) segments.push(current);

    segments.forEach((seg) => {
      const d = seg.map((pt, idx) => (idx === 0 ? "M" : "L") + pt[0].toFixed(1) + "," + pt[1].toFixed(1)).join(" ");
      out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${widthPx}" stroke-linecap="round" stroke-linejoin="round"/>`;
    });

    points.forEach((p, i) => {
      const val = p ? p[valueKey] : null;
      if (val === null || val === undefined) return;
      const r = widthPx > 3.5 ? 5 : 3.5;
      out += `<circle cx="${xAt(i)}" cy="${yAt(val)}" r="${r}" fill="${color}"><title>${escapeHtml(labels[i])}: ${yFormat(val)}</title></circle>`;
    });
  }

  series.filter((s) => visibleSet.has(s.stage)).forEach((s) => {
    drawSeries(s.points, STAGE_LINE_COLORS[s.stage] || "#888", 2.5);
  });

  if (showTotal && total) {
    drawSeries(total.points, TOTAL_COLOR, 5);
  }

  svg.innerHTML = out;
}

/* ---------------------------------------------------------
   Task Count chart
   --------------------------------------------------------- */
let taskMonths = 12;
let taskVisible = new Set(STAGE_KEYS);
let taskShowTotal = true;
let taskData = null;

async function loadTaskChart() {
  try {
    taskData = await apiGet(`/api/analytics/stages?months=${taskMonths}`);
    renderTaskChart();
  } catch (e) {
    console.error(e);
  }
}

function renderTaskChart() {
  if (!taskData) return;
  let maxVal = 0;
  taskData.series.forEach((s) => s.points.forEach((p) => { if (p && p.cnt > maxVal) maxVal = p.cnt; }));
  taskData.total.points.forEach((p) => { if (p && p.cnt > maxVal) maxVal = p.cnt; });

  renderLineChart(document.getElementById("taskChartSvg"), {
    labels: taskData.labels,
    series: taskData.series,
    total: taskData.total,
    visibleSet: taskVisible,
    showTotal: taskShowTotal,
    valueKey: "cnt",
    yMax: computeNiceMax(maxVal),
    yFormat: (v) => String(Math.round(v)),
  });
}

/* ---------------------------------------------------------
   KPI chart
   --------------------------------------------------------- */
let kpiMonths = 12;
let kpiVisible = new Set(STAGE_KEYS);
let kpiShowTotal = true;
let kpiData = null;

async function loadKpiChart() {
  try {
    kpiData = await apiGet(`/api/analytics/stages?months=${kpiMonths}`);
    renderKpiChart();
  } catch (e) {
    console.error(e);
  }
}

function renderKpiChart() {
  if (!kpiData) return;
  renderLineChart(document.getElementById("kpiChartSvg"), {
    labels: kpiData.labels,
    series: kpiData.series,
    total: kpiData.total,
    visibleSet: kpiVisible,
    showTotal: kpiShowTotal,
    valueKey: "pct",
    yMax: 100,
    yFormat: (v) => Math.round(v) + "%",
  });
}

/* ---------------------------------------------------------
   Range controls (independent per chart)
   --------------------------------------------------------- */
document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const chart = btn.dataset.chart;
    document.querySelectorAll(`.range-btn[data-chart="${chart}"]`).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (chart === "task") { taskMonths = parseInt(btn.dataset.months); loadTaskChart(); }
    else { kpiMonths = parseInt(btn.dataset.months); loadKpiChart(); }
  });
});

/* ---------------------------------------------------------
   Init
   --------------------------------------------------------- */
(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  initHeaderFooter("analytics", user);

  renderToggles(
    document.getElementById("taskToggles"), taskVisible,
    () => taskShowTotal, (v) => { taskShowTotal = v; }, renderTaskChart
  );
  renderToggles(
    document.getElementById("kpiToggles"), kpiVisible,
    () => kpiShowTotal, (v) => { kpiShowTotal = v; }, renderKpiChart
  );

  await Promise.all([loadAnalytics(), loadTaskChart(), loadKpiChart()]);
})();
