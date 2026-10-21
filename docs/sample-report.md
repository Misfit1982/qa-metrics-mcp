# QA Health Report — build 1214 (2026-10-14)

**Window:** 14 runs (build 1201 → build 1214) · **Environment:** staging · **Branch:** main

## Summary
- Latest pass rate: **90%** (27/30 executed; 1 skipped). Window average: 92.9%.
- vs previous run: 1 newly failing, 1 fixed, 2 still failing.
- 2 regressed test(s) in 1 incident(s); 3 flaky test(s); 1 test(s) with slowing runtime.

## Regressions (fix first)
- **Introduced in build 1210** (commit `9f3c2ab`, 2026-10-10); last good: 1209
  - `ui.cart::apply_coupon` — 5 consecutive failures: expected cart total 89.99 to equal 80.99 after coupon SAVE10
  - `ui.checkout::tax_calculation` — 5 consecutive failures: expected order total 107.39 to equal 97.67 for CO tax rate 8.81%

## Flaky tests (quarantine or stabilize)
| Test | Fail rate | Flips | Timeline | Suggested fix |
|---|---|---|---|---|
| `api.orders::order_webhook` | 30.8% | 6 | `PPFPPPPFFPFPP` | Downstream dependency is intermittent. Add a mock/contract stub for CI, or retry with backoff only around the async delivery assertion. |
| `ui.search::autocomplete` | 21.4% | 6 | `PFPPPPFPPPPPFP` | Element re-renders between lookup and action. Re-query the locator at action time (Playwright locators, not element handles). |
| `ui.checkout::shipping_options` | 21.4% | 5 | `PPPPPPFPPPFPPF` | Wait on a state (network idle, element enabled, API response) instead of a fixed timeout; check if the element renders conditionally. |

## Environment incidents
- Build 1207 (2026-10-07): `connect ECONNREFUSED inventory-svc:8080` hit 6 tests — excluded from flakiness scoring.

## Performance
- `ui.checkout::guest_checkout`: 7.99s → 19.67s (+146%) — PERFORMANCE DEGRADATION

## Pass-rate trend
| Run | Date | Pass rate | Failed |
|---|---|---|---|
| 1201 | 2026-10-01 | 96.7% | 1 |
| 1202 | 2026-10-02 | 93.3% | 2 |
| 1203 | 2026-10-03 | 93.3% | 2 |
| 1204 | 2026-10-04 | 96.7% | 1 |
| 1205 | 2026-10-05 | 100% | 0 |
| 1206 | 2026-10-06 | 100% | 0 |
| 1207 | 2026-10-07 | 73.3% | 8 |
| 1208 | 2026-10-08 | 100% | 0 |
| 1209 | 2026-10-09 | 96.7% | 1 |
| 1210 | 2026-10-10 | 90% | 3 |
| 1211 | 2026-10-11 | 90% | 3 |
| 1212 | 2026-10-12 | 90% | 3 |
| 1213 | 2026-10-13 | 90% | 3 |
| 1214 | 2026-10-14 | 90% | 3 |

## Skipped
- `ui.auth::mfa_prompt` — Feature flag 'mfa_v2' disabled in staging
