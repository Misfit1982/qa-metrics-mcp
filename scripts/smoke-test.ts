/**
 * End-to-end smoke test: launches the built server over stdio with the official
 * MCP client (the same way Claude Desktop / Claude Code / Cursor do), lists its
 * tools, calls each one and asserts the planted issues in the sample data are found.
 *
 * Usage: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(root, "dist", "server.js")], stderr: "ignore" }));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.ok(!res.isError, `${name} returned an error: ${res.content[0]?.text}`);
  const t = res.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};

let passed = 0;
const check = async (label: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✓ ${label}`);
};

console.log("qa-metrics-mcp smoke test");
const { tools } = await client.listTools();
await check(`exposes ${tools.length} tools`, async () => assert.equal(tools.length, 11));

await check("list_runs finds 14 runs", async () => assert.equal((await call("list_runs")).runs.length, 14));

await check("get_run_summary reports latest failures", async () => {
  const s = await call("get_run_summary");
  assert.equal(s.build, "1214");
  assert.ok(s.failures.some((f: any) => f.test === "ui.cart::apply_coupon"));
});

await check("find_flaky_tests finds the 3 planted flakes and ignores the outage", async () => {
  const f = (await call("find_flaky_tests")).map((x: any) => x.test).sort();
  assert.deepEqual(f, ["api.orders::order_webhook", "ui.checkout::shipping_options", "ui.search::autocomplete"]);
});

await check("detect_regressions pins both pricing breaks to build 1210 / commit 9f3c2ab", async () => {
  const r = await call("detect_regressions");
  assert.equal(r.length, 1);
  assert.equal(r[0].introduced_in.build, "1210");
  assert.equal(r[0].introduced_in.commit, "9f3c2ab");
  assert.deepEqual(r[0].tests.map((t: any) => t.test).sort(), ["ui.cart::apply_coupon", "ui.checkout::tax_calculation"]);
});

await check("get_failure_clusters flags the build 1207 outage as environmental", async () => {
  const c = await call("get_failure_clusters");
  const outage = c.find((x: any) => x.signature.includes("ECONNREFUSED"));
  assert.ok(outage.likely_cause.startsWith("environment"));
  assert.equal(outage.first_seen.build, "1207");
});

await check("compare_runs works between explicit builds", async () => {
  const d = await call("compare_runs", { base: "1209", head: "1210" });
  assert.ok(d.newly_failing.some((x: any) => x.test === "ui.cart::apply_coupon"));
});

await check("get_slowest_tests flags guest_checkout degradation", async () => {
  const s = await call("get_slowest_tests", { top_n: 3 });
  assert.equal(s[0].test, "ui.checkout::guest_checkout");
  assert.equal(s[0].flag, "PERFORMANCE DEGRADATION");
});

await check("get_test_history shows session_timeout was fixed", async () => {
  const [h] = await call("get_test_history", { test: "session_timeout" });
  assert.match(h.timeline, /^FFFFP+$/);
});

await check("get_pass_rate_trend filters by suite", async () => {
  const t = await call("get_pass_rate_trend", { suite: "api.inventory" });
  assert.equal(t[6].pass_rate_pct, 0);
});

await check("generate_quality_report returns markdown", async () => {
  const md = await call("generate_quality_report");
  assert.match(md, /^# QA Health Report/);
});

await check("export_dashboard writes HTML", async () => {
  assert.match(await call("export_dashboard"), /qa-dashboard\.html$/);
});

await check("bad run id returns a clean tool error", async () => {
  const res = (await client.callTool({ name: "get_run_summary", arguments: { run: "nope" } })) as any;
  assert.equal(res.isError, true);
});

await check("nightly_triage prompt is registered", async () => {
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "nightly_triage"));
});

await client.close();
console.log(`\nAll ${passed} checks passed.`);
