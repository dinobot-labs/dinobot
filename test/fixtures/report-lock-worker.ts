import { ReportService } from "../../src/report/service.ts";

/** Child of test/report-lock.test.ts: many separate state mutations of one data directory, racing another process. */
const [dataDir, tag, count] = process.argv.slice(2);
const service = new ReportService({ dataDir: dataDir!, version: "0.0.0" });
for (let i = 0; i < Number(count); i++) await service.recordConsent(`lock:${tag}-${i}`, false);
