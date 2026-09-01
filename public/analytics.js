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
   Init
   --------------------------------------------------------- */
(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  initHeaderFooter("analytics", user);
  await loadAnalytics();
})();
