import type { TestRun } from "./parser.js";
import { detectRegressions, failureClusters, flakyTests, passRateTrend, runSummary, slowestTests } from "./metrics.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Renders a self-contained HTML dashboard (no external assets) for the given runs. */
export function renderDashboard(runs: TestRun[]): string {
  const latest = runs[runs.length - 1];
  const s = runSummary(latest);
  const trend = passRateTrend(runs);
  const flakes = flakyTests(runs);
  const regressions = detectRegressions(runs);
  const outages = failureClusters(runs).filter((c) => c.likely_cause.startsWith("environment"));
  const slow = slowestTests(runs, 15).filter((t) => t.flag);
  const regressedCount = regressions.reduce((a, r) => a + r.tests.length, 0);

  // ---- pass-rate line chart (single series, one axis) ----
  const W = 640, H = 220, pl = 44, pr = 16, pt = 16, pb = 32;
  const minY = Math.max(0, Math.floor(Math.min(...trend.map((t) => t.pass_rate_pct ?? 100)) / 5) * 5 - 5);
  const x = (i: number) => pl + (i * (W - pl - pr)) / Math.max(1, trend.length - 1);
  const y = (v: number) => pt + ((100 - v) * (H - pt - pb)) / (100 - minY);
  const ticks = [];
  for (let v = minY; v <= 100; v += 5) ticks.push(v);
  const path = trend.map((t, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(t.pass_rate_pct ?? 0).toFixed(1)}`).join(" ");
  const lineChart = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pass rate by nightly run" class="chart" data-chart="line">
    ${ticks.map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pl - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${v}%</text>`).join("")}
    ${trend.map((t, i) => (i % 2 === 0 || i === trend.length - 1 ? `<text x="${x(i)}" y="${H - 10}" class="tick" text-anchor="middle">${esc(t.build ?? i + 1)}</text>` : "")).join("")}
    <path d="${path}" class="line"/>
    <line class="crosshair" y1="${pt}" y2="${H - pb}" x1="0" x2="0"/>
    ${trend.map((t, i) => `<circle cx="${x(i)}" cy="${y(t.pass_rate_pct ?? 0)}" r="4" class="dot" data-i="${i}"/>`).join("")}
    ${trend.map((t, i) => `<rect x="${x(i) - (W - pl - pr) / trend.length / 2}" y="${pt}" width="${(W - pl - pr) / trend.length}" height="${H - pt - pb}" class="hit" data-tip="Build ${esc(t.build)} · ${esc(t.date)}&#10;Pass rate ${t.pass_rate_pct}% · ${t.failed} failed" data-x="${x(i)}"/>`).join("")}
  </svg>`;

  // ---- failures per run bar chart ----
  const maxF = Math.max(1, ...trend.map((t) => t.failed));
  const BH = 160, bpb = 28, bpt = 12;
  const bw = (W - pl - pr) / trend.length;
  const bars = `
  <svg viewBox="0 0 ${W} ${BH}" role="img" aria-label="Failed tests by nightly run" class="chart">
    ${[0, Math.ceil(maxF / 2), maxF].map((v) => { const yy = bpt + (1 - v / maxF) * (BH - bpt - bpb); return `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" class="grid"/><text x="${pl - 8}" y="${yy + 4}" class="tick" text-anchor="end">${v}</text>`; }).join("")}
    ${trend.map((t, i) => {
      const h = (t.failed / maxF) * (BH - bpt - bpb);
      const bx = pl + i * bw + 3, bwid = bw - 6, by = BH - bpb - h;
      return `${h > 0 ? `<path d="M${bx},${BH - bpb} V${by + Math.min(4, h)} q0,-4 4,-4 H${bx + bwid - 4} q4,0 4,4 V${BH - bpb} Z" class="bar"/>` : ""}
      <rect x="${pl + i * bw}" y="${bpt}" width="${bw}" height="${BH - bpt - bpb}" class="hit" data-tip="Build ${esc(t.build)} · ${esc(t.date)}&#10;${t.failed} failed of ${t.executed}" data-x="${pl + i * bw + bw / 2}"/>
      ${i % 2 === 0 || i === trend.length - 1 ? `<text x="${pl + i * bw + bw / 2}" y="${BH - 8}" class="tick" text-anchor="middle">${esc(t.build ?? i + 1)}</text>` : ""}`;
    }).join("")}
  </svg>`;

  const timeline = (tl: string) =>
    `<span class="tl" aria-label="${esc(tl)}">${[...tl].map((c) => `<i class="${c === "F" ? "f" : "p"}" title="${c === "F" ? "fail" : "pass"}"></i>`).join("")}</span>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Health Dashboard</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--card:#ffffff;--border:#e6e5e0;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;--series:#2a78d6;--grid:#ecebe6;--good:#0ca30c;--warning:#fab219;--critical:#d03b3b;--pass:#cfd8e3}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--surface:#1a1a19;--card:#222220;--border:#383835;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;--series:#3987e5;--grid:#2e2e2b;--pass:#45505e}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--card:#222220;--border:#383835;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;--series:#3987e5;--grid:#2e2e2b;--pass:#45505e}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:0 0 12px}.sub{color:var(--text2);margin:0 0 24px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;min-width:0}
.tile .k{color:var(--text2);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:30px;font-weight:650;margin-top:4px}.tile .d{color:var(--text2);font-size:12px}
.status{display:inline-flex;align-items:center;gap:6px;font-weight:600}.status::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.crit{color:var(--critical)}.warn{color:#b07800}.ok{color:var(--good)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:16px}
.chart{width:100%;height:auto;display:block}.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.line{fill:none;stroke:var(--series);stroke-width:2}.dot{fill:var(--series);stroke:var(--card);stroke-width:2}.bar{fill:var(--series)}
.hit{fill:transparent;cursor:crosshair}.crosshair{stroke:var(--muted);stroke-dasharray:3 3;opacity:0}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--text2);font-weight:600;font-size:12px}
td:first-child code{white-space:nowrap}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}
.tl{display:inline-flex;gap:2px}.tl i{width:8px;height:14px;border-radius:2px;background:var(--pass)}.tl i.f{background:var(--critical)}
.scroll{overflow-x:auto}ul{margin:0;padding-left:18px}li{margin:4px 0}
#tip{position:fixed;pointer-events:none;background:var(--text);color:var(--surface);padding:6px 10px;border-radius:6px;font-size:12px;white-space:pre;opacity:0;transition:opacity .1s;z-index:10}
footer{color:var(--muted);font-size:12px;margin-top:24px}
</style></head><body><main>
<h1>QA Health Dashboard</h1>
<p class="sub">${esc(runs.length)} nightly runs · build ${esc(runs[0].build)} → ${esc(latest.build)} · ${esc(latest.environment ?? "")} · generated by qa-metrics-mcp</p>

<div class="tiles">
  <div class="card tile"><div class="k">Latest pass rate</div><div class="v">${s.pass_rate_pct}%</div><div class="d">${s.totals.passed}/${s.totals.total - s.totals.skipped} executed · ${s.totals.skipped} skipped</div></div>
  <div class="card tile"><div class="k">Regressions</div><div class="v">${regressedCount}</div><div class="d">${regressedCount ? `<span class="status crit">Critical</span> since build ${esc(regressions[0].introduced_in.build)}` : `<span class="status ok">None</span>`}</div></div>
  <div class="card tile"><div class="k">Flaky tests</div><div class="v">${flakes.length}</div><div class="d">${flakes.length ? `<span class="status warn">Needs attention</span>` : `<span class="status ok">Stable</span>`}</div></div>
  <div class="card tile"><div class="k">Suite runtime</div><div class="v">${Math.round(latest.durationSec)}s</div><div class="d">${slow.length} test(s) slowing</div></div>
</div>

<div class="grid2">
  <div class="card"><h2>Pass rate by build</h2>${lineChart}</div>
  <div class="card"><h2>Failed tests by build</h2>${bars}</div>
</div>

<div class="card" style="margin-bottom:16px"><h2>Regressions</h2>
${regressions.length ? regressions.map((r) => `<p style="margin:0 0 8px"><span class="status crit">Critical</span> Introduced in build <b>${esc(r.introduced_in.build)}</b> (commit <code>${esc(r.introduced_in.commit)}</code>, ${esc(r.introduced_in.date)}) · last good build ${esc(r.last_good.build)}</p><ul>${r.tests.map((t) => `<li><code>${esc(t.test)}</code> — ${esc(t.current_message)}</li>`).join("")}</ul>`).join("") : "<p>None detected.</p>"}
</div>

<div class="card scroll" style="margin-bottom:16px"><h2>Flaky tests</h2>
<table><thead><tr><th>Test</th><th>Fail rate</th><th>Flips</th><th>History (oldest → newest)</th><th>Suggested fix</th></tr></thead><tbody>
${flakes.map((f) => `<tr><td><code>${esc(f.test)}</code></td><td>${f.failure_rate_pct}%</td><td>${f.status_flips}</td><td>${timeline(f.timeline)}</td><td>${esc(f.suggestion)}</td></tr>`).join("")}
</tbody></table></div>

<div class="grid2">
  <div class="card"><h2>Environment incidents</h2>${outages.length ? `<ul>${outages.map((o) => `<li>Build <b>${esc(o.first_seen.build)}</b>: <code>${esc(o.example_message)}</code> hit ${o.tests_affected.length} tests. Excluded from flake scoring.</li>`).join("")}</ul>` : "<p>None.</p>"}</div>
  <div class="card"><h2>Performance drift</h2>${slow.length ? `<ul>${slow.map((t) => `<li><code>${esc(t.test)}</code>: ${t.avg_early_sec}s → ${t.avg_recent_sec}s (+${t.trend_pct}%)</li>`).join("")}</ul>` : "<p>No significant drift.</p>"}</div>
</div>

<div class="card scroll" style="margin-top:16px"><h2>Run data</h2>
<table><thead><tr><th>Build</th><th>Date</th><th>Commit</th><th>Executed</th><th>Failed</th><th>Pass rate</th></tr></thead><tbody>
${trend.map((t) => `<tr><td>${esc(t.build)}</td><td>${esc(t.date)}</td><td><code>${esc(t.commit)}</code></td><td>${t.executed}</td><td>${t.failed}</td><td>${t.pass_rate_pct}%</td></tr>`).join("")}
</tbody></table></div>

<footer>Synthetic demo data for a fictional app. Built with qa-metrics-mcp.</footer>
</main>
<div id="tip" role="tooltip"></div>
<script>
const tip=document.getElementById("tip");
document.querySelectorAll(".hit").forEach(h=>{
  const svg=h.ownerSVGElement, ch=svg.querySelector(".crosshair");
  h.addEventListener("mousemove",e=>{tip.textContent=h.dataset.tip.replace(/&#10;/g,"\\n");tip.style.opacity=1;
    tip.style.left=Math.min(e.clientX+14,innerWidth-200)+"px";tip.style.top=(e.clientY+14)+"px";
    if(ch){ch.setAttribute("x1",h.dataset.x);ch.setAttribute("x2",h.dataset.x);ch.style.opacity=1}});
  h.addEventListener("mouseleave",()=>{tip.style.opacity=0;if(ch)ch.style.opacity=0});
});
</script>
</body></html>`;
}
