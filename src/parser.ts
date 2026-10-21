import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { XMLParser } from "fast-xml-parser";

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface TestCase {
  /** Stable identity across runs: "<suite>::<name>" */
  id: string;
  suite: string;
  name: string;
  durationSec: number;
  status: TestStatus;
  message?: string;
  failureType?: string;
  details?: string;
}

export interface TestRun {
  id: string;
  file: string;
  timestamp: string;
  build?: string;
  commit?: string;
  branch?: string;
  environment?: string;
  durationSec: number;
  cases: TestCase[];
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  parseAttributeValue: false,
  isArray: (name) => ["testsuite", "testcase", "property", "failure", "error"].includes(name),
});

const asText = (node: unknown): string | undefined => {
  if (node == null) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) return String((node as Record<string, unknown>)["#text"]);
  return undefined;
};

/**
 * Parses a JUnit-style XML report. Works with the JUnit output of Maven Surefire,
 * TestNG, Playwright, Cypress, Jest (jest-junit), pytest and GitLab CI artifacts.
 * Accepts either a <testsuites> root or a single <testsuite> root.
 */
export function parseJUnit(content: string, file: string): TestRun {
  const doc = xml.parse(content);
  const root = doc.testsuites ?? { testsuite: doc.testsuite ? [].concat(doc.testsuite) : [] };
  const suites: any[] = root.testsuite ?? [];

  const props: Record<string, string> = {};
  const collectProps = (node: any) => {
    for (const p of node?.properties?.property ?? []) props[p.name] = p.value ?? asText(p) ?? "";
  };
  collectProps(root);
  suites.forEach(collectProps);

  const cases: TestCase[] = [];
  for (const s of suites) {
    for (const tc of s.testcase ?? []) {
      const suite = String(tc.classname ?? s.name ?? "default");
      const name = String(tc.name);
      const failure = tc.failure?.[0];
      const error = tc.error?.[0];
      const problem = failure ?? error;
      const skipped = tc.skipped !== undefined;
      let status: TestStatus = "passed";
      if (failure) status = "failed";
      else if (error) status = "error";
      else if (skipped) status = "skipped";

      const pText = typeof problem === "string" ? problem : asText(problem);
      cases.push({
        id: `${suite}::${name}`,
        suite,
        name,
        durationSec: Number(tc.time ?? 0) || 0,
        status,
        message: problem?.message ?? (skipped ? tc.skipped?.message : undefined) ?? pText?.split("\n")[0],
        failureType: problem?.type,
        details: pText?.trim(),
      });
    }
  }

  const timestamp = root.timestamp ?? suites[0]?.timestamp ?? statSync(file).mtime.toISOString();
  const durationSec = Number(root.time) || cases.reduce((a, c) => a + c.durationSec, 0);
  return {
    id: basename(file, extname(file)),
    file,
    timestamp: new Date(timestamp).toISOString(),
    build: props.build,
    commit: props.commit,
    branch: props.branch,
    environment: props.environment,
    durationSec: +durationSec.toFixed(2),
    cases,
  };
}

/** Loads every *.xml report in a directory, oldest first. */
export function loadRuns(dir: string): TestRun[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xml"));
  } catch {
    throw new Error(`Reports directory not found: ${dir}. Set QA_REPORTS_DIR to a folder of JUnit XML files.`);
  }
  const runs: TestRun[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      runs.push(parseJUnit(readFileSync(path, "utf8"), path));
    } catch (e) {
      console.error(`[qa-metrics-mcp] Skipping unparseable report ${f}: ${(e as Error).message}`);
    }
  }
  return runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
