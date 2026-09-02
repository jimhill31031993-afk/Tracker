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
   Stage completion-rate line chart
   --------------------------------------------------------- */
const STAGE_KEYS = Object.keys(STAGE_DURATIONS).filter((s) => s !== "Not Selected");

let stageMonths = 12;
let stageVisible = new Set(STAGE_KEYS);
let stageData = null;

async function loadStageAnalytics() {
  try {
    stageData = await apiGet(`/api/analytics/stages?months=${stageMonths}`);
    renderStageChart();
  } catch (e) {
    console.error(e);
  }
}

function renderStageToggles() {
  const wrap = document.getElementById("stageToggles");
  wrap.innerHTML = STAGE_KEYS.map((stage) => {
    const color = STAGE_LINE_COLORS[stage];
    const checked = stageVisible.has(stage) ? "checked" : "";
    return `
      <label class="stage-toggle-row">
        <span class="stage-toggle-dot" style="background:${color}"></span>
        <span class="stage-toggle-label">${escapeHtml(stage)}</span>
        <span class="switch">
          <input type="checkbox" data-stage="${escapeHtml(stage)}" ${checked}>
          <span class="switch-slider" style="--on-color:${color}"></span>
        </span>
      </label>`;
  }).join("");

  wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const stage = cb.dataset.stage;
      if (cb.checked) stageVisible.add(stage);
      else stageVisible.delete(stage);
      renderStageChart();
    });
  });
}

function renderStageChart() {
  const svg = document.getElementById("stageChartSvg");
  if (!stageData) { svg.innerHTML = ""; return; }

  const { labels, series } = stageData;
  const W = 900, H = 320, ML = 42, MR = 14, MT = 14, MB = 46;
  const PW = W - ML - MR, PH = H - MT - MB;
  const N = labels.length;
  const xAt = (i) => (N <= 1 ? ML + PW / 2 : ML + (i / (N - 1)) * PW);
  const yAt = (v) => MT + (1 - v / 100) * PH;

  let out = "";

  [0, 25, 50, 75, 100].forEach((v) => {
    const y = yAt(v);
    out += `<line x1="${ML}" y1="${y}" x2="${ML + PW}" y2="${y}" class="grid-line"/>`;
    out += `<text x="${ML - 8}" y="${y + 3}" class="axis-label" text-anchor="end">${v}%</text>`;
  });

  labels.forEach((lab, i) => {
    const x = xAt(i);
    if (N > 12) {
      out += `<text x="${x}" y="${MT + PH + 14}" class="axis-label" text-anchor="end" transform="rotate(-45 ${x} ${MT + PH + 14})">${escapeHtml(lab)}</text>`;
    } else {
      out += `<text x="${x}" y="${MT + PH + 20}" class="axis-label" text-anchor="middle">${escapeHtml(lab)}</text>`;
    }
  });

  series
    .filter((s) => stageVisible.has(s.stage))
    .forEach((s) => {
      const color = STAGE_LINE_COLORS[s.stage] || "#888";
      const segments = [];
      let current = [];
      s.points.forEach((p, i) => {
        if (p === null || p === undefined) {
          if (current.length) { segments.push(current); current = []; }
        } else {
          current.push([xAt(i), yAt(p)]);
        }
      });
      if (current.length) segments.push(current);

      segments.forEach((seg) => {
        const d = seg.map((pt, idx) => (idx === 0 ? "M" : "L") + pt[0].toFixed(1) + "," + pt[1].toFixed(1)).join(" ");
        out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      });

      s.points.forEach((p, i) => {
        if (p === null || p === undefined) return;
        out += `<circle cx="${xAt(i)}" cy="${yAt(p)}" r="3.5" fill="${color}"><title>${escapeHtml(s.stage)} — ${escapeHtml(labels[i])}: ${p}%</title></circle>`;
      });
    });

  svg.innerHTML = out;
}

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    stageMonths = parseInt(btn.dataset.months);
    loadStageAnalytics();
  });
});

/* ---------------------------------------------------------
   Init
   --------------------------------------------------------- */
(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  initHeaderFooter("analytics", user);
  renderStageToggles();
  await Promise.all([loadAnalytics(), loadStageAnalytics()]);
})();
