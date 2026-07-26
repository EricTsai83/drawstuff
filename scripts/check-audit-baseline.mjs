import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const baseline = JSON.parse(
  readFileSync(new URL("../security/audit-baseline.json", import.meta.url)),
);
const accepted = new Set(baseline.advisories);
const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (audit.error) {
  console.error(`Unable to run pnpm audit: ${audit.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("Unable to parse pnpm audit output.");
  if (audit.stderr) console.error(audit.stderr.trim());
  process.exit(1);
}

if (!report.advisories || !report.metadata?.vulnerabilities) {
  console.error("pnpm audit returned an incomplete report.");
  process.exit(1);
}

const findings = Object.values(report.advisories);
if (accepted.size > 0 && findings.length === 0) {
  console.error(
    "pnpm audit returned no advisories for a non-empty reviewed baseline.",
  );
  process.exit(1);
}

const malformed = findings.filter(
  (advisory) =>
    typeof advisory.github_advisory_id !== "string" ||
    typeof advisory.module_name !== "string",
);
if (malformed.length > 0) {
  console.error(
    `pnpm audit returned ${malformed.length} advisory record(s) without a GHSA or package name.`,
  );
  process.exit(1);
}

const current = new Set(
  findings.map(
    (advisory) => `${advisory.github_advisory_id}:${advisory.module_name}`,
  ),
);
const unexpected = [...current].filter((key) => !accepted.has(key)).sort();

if (unexpected.length > 0) {
  console.error(
    "New production dependency advisories are not in the reviewed baseline:",
  );
  unexpected.forEach((key) => console.error(`- ${key}`));
  process.exit(1);
}

const counts = report.metadata.vulnerabilities;
console.log(
  `Production audit matches the ${baseline.reviewedAt} baseline: ` +
    `${counts.critical} critical, ${counts.high} high, ` +
    `${counts.moderate} moderate, ${counts.low} low; no new advisory keys.`,
);
