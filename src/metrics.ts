import type { TestCase, TestRun } from "./parser.js";

const pct = (n: number, d: number) => (d === 0 ? null : +((n / d) * 100).toFixed(1));
const isFail = (c?: TestCase) => c?.status === "failed" || c?.status === "error";
const isPass = (c?: TestCase) => c?.status === "passed";
const label = (r: TestRun) => (r.build ? `build ${r.build}` : r.id);

export const runRef = (r: TestRun) => ({
  run_id: r.id,
  build: r.build,
  commit: r.commit,
  date: r.timestamp.slice(0, 10),
});

/**
 * Collapses a failure message into a signature so the same root cause groups
 * together even when numbers, ids, timeouts or quoted values differ.
 */
export function failureSignature(c: TestCase): string {
  const first = (c.message ?? c.details ?? "unknown failure").split("\n")[0];
  const normalized = first
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/'[^']*'|"[^"]*"/g, "<str>")
    .replace(/\b\d+(\.\d+)?%?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return `${c.failureType ?? "Failure"}: ${normalized}`;
}

// ---------------------------------------------------------------- summaries

export function runSummary(run: TestRun) {
  const total = run.cases.length;
  const count = (s: TestCase["status"]) => run.cases.filter((c) => c.status === s).length;
  const passed = count("passed"), failed = count("failed"), errors = count("error"), skipped = count("skipped");
  const executed = total - skipped;

  const bySuite = new Map<string, TestCase[]>();
  for (const c of run.cases) bySuite.set(c.suite, [...(bySuite.get(c.suite) ?? []), c]);

  return {
    ...runRef(run),
    environment: run.environment,
    branch: run.branch,
    duration_sec: run.durationSec,
    totals: { total, passed, failed, errors, skipped },
    pass_rate_pct: pct(passed, executed),
    suites: [...bySuite.entries()].map(([suite, cs]) => {
      const exec = cs.filter((c) => c.status !== "skipped");
      return {
        suite,
        tests: cs.length,
        failed: cs.filter(isFail).length,
        pass_rate_pct: pct(exec.filter(isPass).length, exec.length),
        duration_sec: +cs.reduce((a, c) => a + c.durationSec, 0).toFixed(2),
      };
    }),
    failures: run.cases.filter(isFail).map((c) => ({ test: c.id, type: c.failureType, message: c.message })),
    skipped_tests: run.cases.filter((c) => c.status === "skipped").map((c) => ({ test: c.id, reason: c.message })),
  };
}

export function passRateTrend(runs: TestRun[], suite?: string) {
  return runs.map((r) => {
    const cs = r.cases.filter((c) => (!suite || c.suite === suite) && c.status !== "skipped");
    return {
      ...runRef(r),
      executed: cs.length,
      failed: cs.filter(isFail).length,
      pass_rate_pct: pct(cs.filter(isPass).length, cs.length),
    };
  });
}

// ---------------------------------------------------------- failure clusters

/** Groups failures across the given runs by normalized root-cause signature. */
export function failureClusters(runs: TestRun[]) {
  const map = new Map<string, { signature: string; tests: Set<string>; runs: Set<string>; occurrences: number; first: TestRun; last: TestRun; example: string }>();
  for (const r of runs) {
    for (const c of r.cases.filter(isFail)) {
      const sig = failureSignature(c);
      const e = map.get(sig) ?? { signature: sig, tests: new Set(), runs: new Set(), occurrences: 0, first: r, last: r, example: c.message ?? "" };
      e.tests.add(c.id);
      e.runs.add(r.id);
      e.occurrences++;
      e.last = r;
      map.set(sig, e);
    }
  }
  return [...map.values()]
    .map((e) => ({
      signature: e.signature,
      example_message: e.example,
      occurrences: e.occurrences,
      tests_affected: [...e.tests],
      runs_affected: e.runs.size,
      first_seen: runRef(e.first),
      last_seen: runRef(e.last),
      likely_cause:
        e.tests.size >= 3 && e.runs.size === 1
          ? "environment/infrastructure (many tests, one run, same error)"
          : e.runs.size === runs.length || (e.runs.size >= 3 && e.last === runs[runs.length - 1] && e.tests.size <= 3)
            ? "persistent product defect or broken test"
            : e.runs.size > 1
              ? "intermittent (possible flakiness)"
              : "one-off failure",
    }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Failures caused by a systemic issue in a single run (same signature hitting
 * many tests at once, e.g. a service outage). These are excluded from flakiness
 * scoring so an outage doesn't make healthy tests look flaky.
 */
function systemicFailureKeys(runs: TestRun[], minTests = 3): Set<string> {
  const keys = new Set<string>();
  for (const r of runs) {
    const bySig = new Map<string, TestCase[]>();
    for (const c of r.cases.filter(isFail)) {
      const sig = failureSignature(c);
      bySig.set(sig, [...(bySig.get(sig) ?? []), c]);
    }
    for (const cs of bySig.values()) if (cs.length >= minTests) cs.forEach((c) => keys.add(`${r.id}|${c.id}`));
  }
  return keys;
}

// ---------------------------------------------------------------- histories

type Outcome = "P" | "F" | "S" | "-";
function histories(runs: TestRun[]) {
  const ids = new Set(runs.flatMap((r) => r.cases.map((c) => c.id)));
  const index = runs.map((r) => new Map(r.cases.map((c) => [c.id, c])));
  return [...ids].map((id) => ({
    id,
    cases: index.map((m) => m.get(id)),
  }));
}

export function testHistory(runs: TestRun[], query: string) {
  const q = query.toLowerCase();
  const matches = histories(runs).filter((h) => h.id.toLowerCase().includes(q));
  return matches.slice(0, 10).map((h) => {
    const outcomes = h.cases.map((c): Outcome => (!c ? "-" : isFail(c) ? "F" : c.status === "skipped" ? "S" : "P"));
    const executed = h.cases.filter((c) => c && c.status !== "skipped");
    return {
      test: h.id,
      timeline: outcomes.join(""),
      timeline_legend: "P=pass F=fail S=skipped -=not run; oldest → newest",
      failure_rate_pct: pct(executed.filter(isFail).length, executed.length),
      runs: h.cases.map((c, i) => ({
        ...runRef(runs[i]),
        status: c?.status ?? "not_run",
        duration_sec: c?.durationSec,
        message: isFail(c) ? c!.message : undefined,
      })),
    };
  });
}

// ------------------------------------------------------------------- flakes

export function flakyTests(runs: TestRun[], opts: { minFailures?: number; minFlips?: number } = {}) {
  const minFailures = opts.minFailures ?? 2;
  const minFlips = opts.minFlips ?? 3;
  const systemic = systemicFailureKeys(runs);
  const results = [];

  for (const h of histories(runs)) {
    // Outcomes ignoring skips, not-run, and failures explained by a systemic outage.
    const seq: Array<{ fail: boolean; run: TestRun; c: TestCase }> = [];
    let excluded = 0;
    h.cases.forEach((c, i) => {
      if (!c || c.status === "skipped") return;
      if (isFail(c) && systemic.has(`${runs[i].id}|${c.id}`)) return void excluded++;
      seq.push({ fail: isFail(c), run: runs[i], c });
    });
    const failures = seq.filter((s) => s.fail);
    if (failures.length < minFailures || failures.length === seq.length) continue;
    let flips = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i].fail !== seq[i - 1].fail) flips++;
    if (flips < minFlips) continue;

    const sigs = new Map<string, number>();
    failures.forEach((f) => sigs.set(failureSignature(f.c), (sigs.get(failureSignature(f.c)) ?? 0) + 1));
    const flakiness = +(flips / (seq.length - 1)).toFixed(2);
    results.push({
      test: h.id,
      runs_considered: seq.length,
      failures: failures.length,
      failure_rate_pct: pct(failures.length, seq.length),
      status_flips: flips,
      flakiness_score: flakiness,
      timeline: seq.map((s) => (s.fail ? "F" : "P")).join(""),
      outage_failures_excluded: excluded,
      failure_signatures: [...sigs.entries()].map(([signature, count]) => ({ signature, count })),
      last_failure: runRef(failures[failures.length - 1].run),
      suggestion: suggestFlakeFix([...sigs.keys()].join(" ")),
    });
  }
  return results.sort((a, b) => b.flakiness_score - a.flakiness_score || b.failures - a.failures);
}

function suggestFlakeFix(sig: string): string {
  if (/50[234]|Gateway|ECONN/i.test(sig)) return "Downstream dependency is intermittent. Add a mock/contract stub for CI, or retry with backoff only around the async delivery assertion.";
  if (/Timeout/i.test(sig)) return "Wait on a state (network idle, element enabled, API response) instead of a fixed timeout; check if the element renders conditionally.";
  if (/not attached|stale/i.test(sig)) return "Element re-renders between lookup and action. Re-query the locator at action time (Playwright locators, not element handles).";
  return "Review test isolation (shared data, ordering, time-dependent assertions).";
}

// -------------------------------------------------------------- regressions

/**
 * A regression is a test that was stable-passing and has failed in every one of
 * the most recent runs since a specific build. Reports the first bad build/commit.
 */
export function detectRegressions(runs: TestRun[], opts: { minStablePasses?: number; minConsecutiveFails?: number } = {}) {
  const minPasses = opts.minStablePasses ?? 3;
  const minFails = opts.minConsecutiveFails ?? 2;
  const out = [];
  for (const h of histories(runs)) {
    const cs = h.cases;
    let i = cs.length - 1;
    while (i >= 0 && isFail(cs[i])) i--;
    const streak = cs.length - 1 - i;
    if (streak < minFails) continue;
    const before = cs.slice(0, i + 1).filter((c) => c && c.status !== "skipped");
    const priorPasses = before.slice(-minPasses);
    if (priorPasses.length < minPasses || !priorPasses.every(isPass)) continue;
    const firstBad = runs[i + 1];
    out.push({
      test: h.id,
      consecutive_failures: streak,
      first_failing: runRef(firstBad),
      last_passing: runRef(runs[i]),
      current_message: cs[cs.length - 1]?.message,
      signature: failureSignature(cs[cs.length - 1]!),
    });
  }
  // Group by first failing build so related breakages read as one incident.
  const byBuild = new Map<string, typeof out>();
  for (const r of out) byBuild.set(r.first_failing.run_id, [...(byBuild.get(r.first_failing.run_id) ?? []), r]);
  return [...byBuild.values()].map((rs) => ({
    introduced_in: rs[0].first_failing,
    last_good: rs[0].last_passing,
    tests: rs.map(({ first_failing, last_passing, ...rest }) => rest),
  }));
}

// ---------------------------------------------------------------- compare

export function compareRuns(base: TestRun, head: TestRun) {
  const b = new Map(base.cases.map((c) => [c.id, c]));
  const h = new Map(head.cases.map((c) => [c.id, c]));
  const newlyFailing = [], fixed = [], stillFailing = [], slower = [], faster = [];
  for (const [id, hc] of h) {
    const bc = b.get(id);
    if (!bc) continue;
    if (isFail(hc) && isPass(bc)) newlyFailing.push({ test: id, message: hc.message });
    else if (isPass(hc) && isFail(bc)) fixed.push({ test: id, previous_message: bc.message });
    else if (isFail(hc) && isFail(bc)) stillFailing.push({ test: id, message: hc.message });
    if (bc.durationSec > 0 && hc.durationSec > 0) {
      const delta = hc.durationSec - bc.durationSec;
      const change = delta / bc.durationSec;
      const row = { test: id, base_sec: bc.durationSec, head_sec: hc.durationSec, change_pct: +(change * 100).toFixed(0) };
      if (change > 0.3 && delta > 1) slower.push(row);
      if (change < -0.3 && delta < -1) faster.push(row);
    }
  }
  const sb = runSummary(base), sh = runSummary(head);
  return {
    base: runRef(base),
    head: runRef(head),
    pass_rate_pct: { base: sb.pass_rate_pct, head: sh.pass_rate_pct },
    duration_sec: { base: base.durationSec, head: head.durationSec },
    newly_failing: newlyFailing,
    fixed,
    still_failing: stillFailing,
    added_tests: [...h.keys()].filter((id) => !b.has(id)),
    removed_tests: [...b.keys()].filter((id) => !h.has(id)),
    significantly_slower: slower.sort((x, y) => y.change_pct - x.change_pct),
    significantly_faster: faster,
  };
}

// --------------------------------------------------------------- durations

export function slowestTests(runs: TestRun[], topN = 10) {
  const latest = runs[runs.length - 1];
  const hs = new Map(histories(runs).map((x) => [x.id, x.cases]));
  const third = Math.max(1, Math.floor(runs.length / 3));
  const avg = (xs: Array<TestCase | undefined>) => {
    const ds = xs.filter((c): c is TestCase => !!c && c.status !== "skipped").map((c) => c.durationSec);
    return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
  };
  return latest.cases
    .filter((c) => c.status !== "skipped")
    .sort((a, b) => b.durationSec - a.durationSec)
    .slice(0, topN)
    .map((c) => {
      const cs = hs.get(c.id) ?? [];
      const early = avg(cs.slice(0, third)), recent = avg(cs.slice(-third));
      const trend = early ? (recent - early) / early : 0;
      return {
        test: c.id,
        latest_sec: c.durationSec,
        avg_early_sec: +early.toFixed(2),
        avg_recent_sec: +recent.toFixed(2),
        trend_pct: +(trend * 100).toFixed(0),
        flag: trend > 0.5 ? "PERFORMANCE DEGRADATION" : trend > 0.2 ? "slowing" : undefined,
      };
    });
}

// ----------------------------------------------------------------- report

export function qualityReport(runs: TestRun[]): string {
  const latest = runs[runs.length - 1];
  const prev = runs[runs.length - 2];
  const s = runSummary(latest);
  const trend = passRateTrend(runs);
  const flakes = flakyTests(runs);
  const regressions = detectRegressions(runs);
  const outages = failureClusters(runs).filter((c) => c.likely_cause.startsWith("environment"));
  const slow = slowestTests(runs, 15).filter((t) => t.flag);
  const avgRate = trend.reduce((a, t) => a + (t.pass_rate_pct ?? 0), 0) / trend.length;
  const cmp = prev ? compareRuns(prev, latest) : undefined;

  const L: string[] = [];
  L.push(`# QA Health Report — ${label(latest)} (${s.date})`);
  L.push("");
  L.push(`**Window:** ${runs.length} runs (${label(runs[0])} → ${label(latest)}) · **Environment:** ${latest.environment ?? "n/a"} · **Branch:** ${latest.branch ?? "n/a"}`);
  L.push("");
  L.push("## Summary");
  L.push(`- Latest pass rate: **${s.pass_rate_pct}%** (${s.totals.passed}/${s.totals.total - s.totals.skipped} executed; ${s.totals.skipped} skipped). Window average: ${avgRate.toFixed(1)}%.`);
  if (cmp) L.push(`- vs previous run: ${cmp.newly_failing.length} newly failing, ${cmp.fixed.length} fixed, ${cmp.still_failing.length} still failing.`);
  L.push(`- ${regressions.reduce((a, r) => a + r.tests.length, 0)} regressed test(s) in ${regressions.length} incident(s); ${flakes.length} flaky test(s); ${slow.length} test(s) with slowing runtime.`);
  L.push("");
  L.push("## Regressions (fix first)");
  if (!regressions.length) L.push("None detected.");
  for (const r of regressions) {
    L.push(`- **Introduced in ${r.introduced_in.build ? "build " + r.introduced_in.build : r.introduced_in.run_id}** (commit \`${r.introduced_in.commit ?? "?"}\`, ${r.introduced_in.date}); last good: ${r.last_good.build ?? r.last_good.run_id}`);
    for (const t of r.tests) L.push(`  - \`${t.test}\` — ${t.consecutive_failures} consecutive failures: ${t.current_message}`);
  }
  L.push("");
  L.push("## Flaky tests (quarantine or stabilize)");
  if (!flakes.length) L.push("None detected.");
  else {
    L.push("| Test | Fail rate | Flips | Timeline | Suggested fix |");
    L.push("|---|---|---|---|---|");
    for (const f of flakes) L.push(`| \`${f.test}\` | ${f.failure_rate_pct}% | ${f.status_flips} | \`${f.timeline}\` | ${f.suggestion} |`);
  }
  L.push("");
  L.push("## Environment incidents");
  if (!outages.length) L.push("None detected.");
  for (const o of outages) L.push(`- ${o.first_seen.build ? "Build " + o.first_seen.build : o.first_seen.run_id} (${o.first_seen.date}): \`${o.example_message}\` hit ${o.tests_affected.length} tests — excluded from flakiness scoring.`);
  L.push("");
  L.push("## Performance");
  if (!slow.length) L.push("No significant runtime drift.");
  for (const t of slow) L.push(`- \`${t.test}\`: ${t.avg_early_sec}s → ${t.avg_recent_sec}s (+${t.trend_pct}%) — ${t.flag}`);
  L.push("");
  L.push("## Pass-rate trend");
  L.push("| Run | Date | Pass rate | Failed |");
  L.push("|---|---|---|---|");
  for (const t of trend) L.push(`| ${t.build ?? t.run_id} | ${t.date} | ${t.pass_rate_pct}% | ${t.failed} |`);
  if (s.skipped_tests.length) {
    L.push("");
    L.push("## Skipped");
    for (const k of s.skipped_tests) L.push(`- \`${k.test}\` — ${k.reason}`);
  }
  return L.join("\n");
}
