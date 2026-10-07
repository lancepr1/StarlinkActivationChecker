import assert from "node:assert/strict";
import test from "node:test";
import { defaultProxyPool } from "../lib/proxyPool.js";

test("defaultProxyPool is instantiated and functional", () => {
  assert.ok(defaultProxyPool);
  const health = defaultProxyPool.health();
  assert.equal(typeof health.configured, "number");
  assert.equal(typeof health.enabled, "boolean");
  assert.equal(typeof health.strategy, "string");
  assert.ok(Array.isArray(health.coolingDown));
});
