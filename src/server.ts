#!/usr/bin/env node
/**
 * qa-metrics-mcp — an MCP server that lets an AI assistant (Claude, Cursor, etc.)
 * answer QA questions directly from JUnit XML test reports:
 *   "What's flaky?", "What broke last night and which commit did it?",
 *   "Write the nightly QA summary", "Build me a dashboard."
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRuns, type TestRun } from "./parser.js";
import {
  compareRuns,
  detectRegressions,
  failureClusters,
  flakyTests,
  passRateTrend,
  qualityReport,
  runRef,
  runSummary,
  slowestTests,
  testHistory,
} from "./metrics.js";
import { renderDashboard } from "./dashboard.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(process.env.QA_REPORTS_DIR ?? join(ROOT, "sample-data", "reports"));
const OUTPUT_DIR = resolve(process.env.QA_OUTPUT_DIR ?? join(ROOT, "output"));

/** Reports are re-read on every call so new CI artifacts show up without a restart. */
function runs(lastN?: number): TestRun[] {
  const all = loadRuns(REPORTS_DIR);
  if (!all.length) throw new Error(`No JUnit XML reports found in ${REPORTS_DIR}`);
  return lastN ? all.slice(-lastN) : all;
}

function findRun(all: TestRun[], ref?: string): TestRun {
  if (!ref || ref === "latest") return all[all.length - 1];
  if (ref === "previous") return all[all.length - 2] ?? all[0];
  const hit = all.find((r) => r.id === ref || r.build === ref || r.commit?.startsWith(ref));
  if (!hit) throw new Error(`Run '${ref}' not found. Use list_runs to see run ids, builds and commits.`);
  return hit;
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Wraps a handler so errors come back as readable tool errors instead of crashing. */
function safe<A>(fn: (args: A) => ReturnType<typeof json>) {
  return async (args: A) => {
    try {
      return fn(args);
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}

const lastN = z.number().int().min(2).max(500).optional().describe("Only consider the most recent N runs (default: all runs)");
const runId = (what: string) => z.string().optional().describe(`${what}: run id, build number, commit prefix, 'latest' or 'previous'`);
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

const server = new McpServer({ name: "qa-metrics-mcp", version: "1.0.0" });

server.registerTool(
  "list_runs",
  { title: "List test runs", description: "List available test runs (oldest first) with build, commit, date and headline pass rate.", inputSchema: { last_n: lastN }, annotations: readOnly },
  safe(({ last_n }) =>
    json({
      reports_dir: REPORTS_DIR,
      runs: runs(last_n).map((r) => {
        const s = runSummary(r);
        return { ...runRef(r), environment: r.environment, tests: s.totals.total, failed: s.totals.failed + s.totals.errors, pass_rate_pct: s.pass_rate_pct };
      }),
    }),
  ),
);

server.registerTool(
  "get_run_summary",
  { title: "Run summary", description: "Totals, pass rate, per-suite breakdown, every failure and skipped test for one run.", inputSchema: { run: runId("Which run (default latest)") }, annotations: readOnly },
  safe(({ run }) => json(runSummary(findRun(runs(), run)))),
);

server.registerTool(
  "get_pass_rate_trend",
  { title: "Pass-rate trend", description: "Pass rate per run over time, overall or for one suite (e.g. 'ui.checkout').", inputSchema: { suite: z.string().optional().describe("Suite/classname to filter to"), last_n: lastN }, annotations: readOnly },
  safe(({ suite, last_n }) => json(passRateTrend(runs(last_n), suite))),
);

server.registerTool(
  "find_flaky_tests",
  {
    title: "Find flaky tests",
    description:
      "Detect flaky tests: tests that flip between pass and fail across runs. Failures caused by a systemic outage in a single run (same error hitting 3+ tests) are excluded so outages don't masquerade as flakiness. Returns score, timeline, failure signatures and a suggested fix.",
    inputSchema: {
      last_n: lastN,
      min_failures: z.number().int().min(1).optional().describe("Minimum failures to be considered (default 2)"),
      min_flips: z.number().int().min(1).optional().describe("Minimum pass↔fail transitions (default 3)"),
    },
    annotations: readOnly,
  },
  safe(({ last_n, min_failures, min_flips }) => json(flakyTests(runs(last_n), { minFailures: min_failures, minFlips: min_flips }))),
);

server.registerTool(
  "detect_regressions",
  {
    title: "Detect regressions",
    description: "Find tests that were stable-passing and are now failing consistently. Groups them by the build/commit where they first broke, so you know what change to investigate.",
    inputSchema: {
      last_n: lastN,
      min_stable_passes: z.number().int().min(1).optional().describe("Passes required before the break (default 3)"),
      min_consecutive_fails: z.number().int().min(1).optional().describe("Consecutive failures up to the latest run (default 2)"),
    },
    annotations: readOnly,
  },
  safe(({ last_n, min_stable_passes, min_consecutive_fails }) =>
    json(detectRegressions(runs(last_n), { minStablePasses: min_stable_passes, minConsecutiveFails: min_consecutive_fails })),
  ),
);

server.registerTool(
  "compare_runs",
  { title: "Compare two runs", description: "Diff two runs: newly failing, fixed, still failing, added/removed tests and significant duration changes. Defaults to previous vs latest.", inputSchema: { base: runId("Baseline run (default previous)"), head: runId("Run to compare (default latest)") }, annotations: readOnly },
  safe(({ base, head }) => {
    const all = runs();
    return json(compareRuns(findRun(all, base ?? "previous"), findRun(all, head ?? "latest")));
  }),
);

server.registerTool(
  "get_failure_clusters",
  { title: "Failure clusters", description: "Group failures by normalized root-cause signature (numbers, ids and quoted values stripped) and classify each cluster: environment outage, persistent defect, intermittent, or one-off. Useful as the starting point for an RCA.", inputSchema: { run: runId("Limit to one run (default: all runs in window)"), last_n: lastN }, annotations: readOnly },
  safe(({ run, last_n }) => {
    const all = runs(last_n);
    return json(failureClusters(run ? [findRun(all, run)] : all));
  }),
);

server.registerTool(
  "get_slowest_tests",
  { title: "Slowest tests", description: "Slowest tests in the latest run with their duration trend across the window; flags performance degradation.", inputSchema: { top_n: z.number().int().min(1).max(100).optional().describe("How many (default 10)"), last_n: lastN }, annotations: readOnly },
  safe(({ top_n, last_n }) => json(slowestTests(runs(last_n), top_n ?? 10))),
);

server.registerTool(
  "get_test_history",
  { title: "Test history", description: "Run-by-run history (status, duration, message) for tests whose id contains the query, e.g. 'apply_coupon' or 'ui.checkout'.", inputSchema: { test: z.string().min(1).describe("Full or partial test id"), last_n: lastN }, annotations: readOnly },
  safe(({ test, last_n }) => {
    const h = testHistory(runs(last_n), test);
    return h.length ? json(h) : text(`No tests match '${test}'.`);
  }),
);

server.registerTool(
  "generate_quality_report",
  { title: "QA health report", description: "Markdown QA health report: summary, regressions with the commit that introduced them, flaky tests with fixes, environment incidents, performance drift and pass-rate trend. Ready to paste into Slack, Confluence or a Jira comment.", inputSchema: { last_n: lastN }, annotations: readOnly },
  safe(({ last_n }) => text(qualityReport(runs(last_n)))),
);

server.registerTool(
  "export_dashboard",
  { title: "Export HTML dashboard", description: "Write a self-contained HTML QA dashboard (KPI tiles, pass-rate and failure charts, regressions, flaky tests) to the output folder and return its path.", inputSchema: { last_n: lastN, filename: z.string().regex(/^[\w.-]+\.html$/).optional().describe("Output file name (default qa-dashboard.html)") }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  safe(({ last_n, filename }) => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, filename ?? "qa-dashboard.html");
    writeFileSync(path, renderDashboard(runs(last_n)));
    return text(`Dashboard written to ${path}`);
  }),
);

server.registerPrompt(
  "nightly_triage",
  { title: "Nightly triage", description: "Triage last night's run: what broke, why, who should look, and what to quarantine." },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Triage the latest nightly test run. Use compare_runs (previous vs latest), detect_regressions, find_flaky_tests and get_failure_clusters. " +
            "Then give me: (1) a 3-line executive summary, (2) regressions with the build/commit that introduced them and a draft bug title for each, " +
            "(3) flaky tests to quarantine with the suggested fix, (4) any environment incidents to raise with DevOps. Be concise.",
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[qa-metrics-mcp] ready · reports: ${REPORTS_DIR}`);
