/**
 * Generates realistic, fully synthetic JUnit XML nightly reports for a fictional
 * e-commerce app ("ShopLite"). The data is deterministic (seeded PRNG) and has
 * known problems planted in it so every MCP tool has something real to find:
 *
 *   - Flaky tests:      checkout.shipping_options, search.autocomplete, api.orders.order_webhook
 *   - Regression:       pricing change in build 1210 breaks cart.apply_coupon + checkout.tax_calculation
 *   - Fixed test:       auth.session_timeout fails in builds 1201-1204, then fixed
 *   - Perf degradation: checkout.guest_checkout slows from ~8s to ~22s
 *   - Outage:           build 1207 has an inventory-service outage hitting several API tests
 *   - Skipped:          auth.mfa_prompt is behind a disabled feature flag
 *
 * Usage: npm run generate-data
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sample-data", "reports");
const RUN_COUNT = 14;
const FIRST_BUILD = 1201;
const START_DATE = Date.UTC(2026, 9, 1, 7, 0, 0); // Oct 1 2026, 07:00 UTC nightly

// ---- deterministic PRNG (mulberry32) ----
let seed = Number(process.env.SEED ?? 20261006);
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const jitter = (base: number, pct = 0.15) => +(base * (1 - pct + rand() * pct * 2)).toFixed(3);
const sha = () => Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

type Outcome =
  | { status: "passed" }
  | { status: "skipped"; message: string }
  | { status: "failed" | "error"; message: string; type: string; details: string };

interface TestDef {
  suite: string;
  name: string;
  baseDuration: number;
  behavior?: (runIndex: number) => Outcome | null; // null = use default (pass)
  duration?: (runIndex: number) => number;
}

const SUITES: Record<string, Array<[string, number]>> = {
  "ui.auth": [["login_valid", 2.1], ["login_invalid_password", 1.8], ["logout", 1.2], ["password_reset_email", 3.4], ["session_timeout", 5.2], ["mfa_prompt", 2.6]],
  "ui.cart": [["add_item", 2.4], ["remove_item", 2.2], ["update_quantity", 2.9], ["apply_coupon", 3.1], ["cart_persists_after_login", 4.0], ["empty_cart_message", 1.1]],
  "ui.checkout": [["guest_checkout", 8.0], ["saved_card_checkout", 6.5], ["tax_calculation", 3.8], ["shipping_options", 4.4], ["order_confirmation_email", 5.9], ["address_validation", 3.3]],
  "ui.search": [["keyword_search", 1.9], ["filter_by_price", 2.7], ["sort_by_rating", 2.5], ["no_results_page", 1.4], ["autocomplete", 2.0]],
  "api.orders": [["create_order", 0.42], ["get_order", 0.18], ["cancel_order", 0.35], ["list_orders_pagination", 0.61], ["order_webhook", 1.2]],
  "api.inventory": [["stock_decrement", 0.29], ["low_stock_alert", 0.44], ["restock", 0.31]],
};

const stack = (frames: string[]) => frames.map((f) => `    at ${f}`).join("\n");

const OUTAGE_RUN = 6; // build 1207
const REGRESSION_START = 9; // build 1210
const outage = (svc: string): Outcome => ({
  status: "error",
  type: "Error",
  message: `connect ECONNREFUSED ${svc}:8080`,
  details: `Error: connect ECONNREFUSED ${svc}:8080\n${stack(["TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)", "ApiClient.request (tests/api/client.ts:48:11)"])}`,
});

const behaviors: Record<string, Partial<TestDef>> = {
  "ui.auth::session_timeout": {
    behavior: (i) =>
      i <= 3
        ? {
            status: "failed",
            type: "AssertionError",
            message: "expected url '/dashboard' to include '/login?expired=1'",
            details: `AssertionError: expected url '/dashboard' to include '/login?expired=1'\n${stack(["SessionPage.assertRedirectedToLogin (tests/ui/pages/session.ts:31:9)", "tests/ui/auth.spec.ts:88:5"])}`,
          }
        : null,
  },
  "ui.auth::mfa_prompt": { behavior: () => ({ status: "skipped", message: "Feature flag 'mfa_v2' disabled in staging" }) },
  "ui.cart::apply_coupon": {
    behavior: (i) =>
      i >= REGRESSION_START
        ? {
            status: "failed",
            type: "AssertionError",
            message: "expected cart total 89.99 to equal 80.99 after coupon SAVE10",
            details: `AssertionError: expected cart total 89.99 to equal 80.99 after coupon SAVE10\n${stack(["CartPage.assertTotal (tests/ui/pages/cart.ts:72:7)", "tests/ui/cart.spec.ts:114:5"])}`,
          }
        : null,
  },
  "ui.checkout::tax_calculation": {
    behavior: (i) =>
      i >= REGRESSION_START
        ? {
            status: "failed",
            type: "AssertionError",
            message: "expected order total 107.39 to equal 97.67 for CO tax rate 8.81%",
            details: `AssertionError: expected order total 107.39 to equal 97.67 for CO tax rate 8.81%\n${stack(["CheckoutPage.assertOrderTotal (tests/ui/pages/checkout.ts:140:7)", "tests/ui/checkout.spec.ts:203:5"])}`,
          }
        : null,
  },
  "ui.checkout::shipping_options": {
    behavior: () =>
      rand() < 0.32
        ? {
            status: "failed",
            type: "TimeoutError",
            message: `locator.click: Timeout ${[15000, 15000, 30000][Math.floor(rand() * 3)]}ms exceeded waiting for '[data-test=shipping-express]'`,
            details: `TimeoutError: locator.click: Timeout exceeded waiting for '[data-test=shipping-express]'\n${stack(["ShippingStep.selectExpress (tests/ui/pages/shipping.ts:22:18)", "tests/ui/checkout.spec.ts:156:5"])}`,
          }
        : null,
  },
  "ui.checkout::guest_checkout": {
    duration: (i) => jitter(8 + Math.max(0, i - 5) * 1.75, 0.06),
  },
  "ui.search::autocomplete": {
    behavior: () =>
      rand() < 0.28
        ? {
            status: "failed",
            type: "Error",
            message: "elementHandle.click: Element is not attached to the DOM",
            details: `Error: elementHandle.click: Element is not attached to the DOM\n${stack(["SearchBar.pickSuggestion (tests/ui/pages/search.ts:47:12)", "tests/ui/search.spec.ts:61:5"])}`,
          }
        : null,
  },
  "api.orders::order_webhook": {
    behavior: (i) =>
      i === OUTAGE_RUN
        ? outage("inventory-svc")
        : rand() < 0.24
          ? {
              status: "failed",
              type: "AssertionError",
              message: "expected status 200 but received 504 Gateway Timeout from /hooks/order-created",
              details: `AssertionError: expected status 200 but received 504 Gateway Timeout from /hooks/order-created\n${stack(["assertWebhookDelivered (tests/api/orders.webhook.spec.ts:39:10)"])}`,
            }
          : null,
  },
};
for (const name of ["create_order", "cancel_order"]) behaviors[`api.orders::${name}`] = { behavior: (i) => (i === OUTAGE_RUN ? outage("inventory-svc") : null) };
for (const name of ["stock_decrement", "low_stock_alert", "restock"]) behaviors[`api.inventory::${name}`] = { behavior: (i) => (i === OUTAGE_RUN ? outage("inventory-svc") : null) };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function buildRun(i: number): string {
  const build = FIRST_BUILD + i;
  const ts = new Date(START_DATE + i * 86_400_000 + Math.floor(rand() * 600) * 1000).toISOString();
  const commit = i === REGRESSION_START ? "9f3c2ab" : sha();
  let totals = { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 };
  const suitesXml: string[] = [];

  for (const [suite, tests] of Object.entries(SUITES)) {
    let s = { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 };
    const casesXml: string[] = [];
    for (const [name, base] of tests) {
      const def = behaviors[`${suite}::${name}`] ?? {};
      const outcome: Outcome = def.behavior?.(i) ?? { status: "passed" };
      const time = outcome.status === "skipped" ? 0 : def.duration ? def.duration(i) : jitter(base);
      s.tests++;
      s.time += time;
      let inner = "";
      if (outcome.status === "skipped") {
        s.skipped++;
        inner = `<skipped message="${esc(outcome.message)}"/>`;
      } else if (outcome.status === "failed" || outcome.status === "error") {
        outcome.status === "failed" ? s.failures++ : s.errors++;
        const tag = outcome.status === "failed" ? "failure" : "error";
        inner = `<${tag} message="${esc(outcome.message)}" type="${outcome.type}">${esc(outcome.details)}</${tag}>`;
      }
      casesXml.push(
        `    <testcase classname="${suite}" name="${name}" time="${time.toFixed(3)}"${inner ? `>\n      ${inner}\n    </testcase>` : "/>"}`,
      );
    }
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += s[k];
    suitesXml.push(
      `  <testsuite name="${suite}" tests="${s.tests}" failures="${s.failures}" errors="${s.errors}" skipped="${s.skipped}" time="${s.time.toFixed(3)}" timestamp="${ts}">\n${casesXml.join("\n")}\n  </testsuite>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Synthetic data for the qa-metrics-mcp demo. Fictional app "ShopLite". -->
<testsuites name="shoplite-nightly" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}" time="${totals.time.toFixed(3)}" timestamp="${ts}">
  <properties>
    <property name="build" value="${build}"/>
    <property name="commit" value="${commit}"/>
    <property name="branch" value="main"/>
    <property name="environment" value="staging"/>
    <property name="pipeline" value="gitlab-ci/nightly-regression"/>
  </properties>
${suitesXml.join("\n")}
</testsuites>
`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".xml")) rmSync(join(OUT_DIR, f));
for (let i = 0; i < RUN_COUNT; i++) {
  const date = new Date(START_DATE + i * 86_400_000).toISOString().slice(0, 10);
  const file = join(OUT_DIR, `nightly-${date}-build-${FIRST_BUILD + i}.xml`);
  writeFileSync(file, buildRun(i));
}
console.log(`Wrote ${RUN_COUNT} JUnit reports to ${OUT_DIR}`);
