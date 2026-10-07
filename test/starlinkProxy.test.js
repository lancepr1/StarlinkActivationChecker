import assert from "node:assert/strict";
import test from "node:test";
import { checkIdentifier } from "../lib/starlink.js";

test("checkIdentifier uses pool and reports failures when proxies fail", async () => {
  const reportedFailures = [];
  const picked = [];

  const mockPool = {
    enabled: true,
    size: 2,
    next() {
      const p = picked.length === 0 ? "http://dead-proxy-1.test:8080/" : "http://dead-proxy-2.test:8080/";
      picked.push(p);
      return p;
    },
    getDispatcher() {
      return undefined;
    },
    reportFailure(proxy, err) {
      reportedFailures.push({ proxy, err });
    },
    reportSuccess() {},
    reportRateLimited() {},
  };

  // Run with a very short timeout so test finishes swiftly
  const result = await checkIdentifier("KIT4M001234567", {
    pool: mockPool,
    timeoutMs: 100,
  });

  // Failed to connect through dead proxies
  assert.equal(result.status, "error");
  assert.ok(reportedFailures.length > 0);
  assert.equal(reportedFailures[0].proxy, "http://dead-proxy-1.test:8080/");
});
