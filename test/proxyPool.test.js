import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProxy, sanitizeProxy, loadProxies, ProxyPool } from "../lib/proxyPool.js";

test("normalizes various proxy string formats", () => {
  assert.equal(normalizeProxy("198.51.100.1:8080"), "http://198.51.100.1:8080/");
  assert.equal(normalizeProxy("http://198.51.100.1:8080"), "http://198.51.100.1:8080/");
  assert.equal(normalizeProxy("https://proxy.example.com:8443"), "https://proxy.example.com:8443/");
  assert.equal(normalizeProxy("198.51.100.1:8080:alice:secret123"), "http://alice:secret123@198.51.100.1:8080/");
  assert.equal(normalizeProxy("alice:secret123@198.51.100.1:8080"), "http://alice:secret123@198.51.100.1:8080/");
  assert.equal(normalizeProxy("http://alice:secret123@198.51.100.1:8080"), "http://alice:secret123@198.51.100.1:8080/");

  // Comments and empty lines
  assert.equal(normalizeProxy("# this is a comment"), null);
  assert.equal(normalizeProxy("   "), null);
  assert.equal(normalizeProxy(null), null);

  // Unsupported protocols or garbage
  assert.equal(normalizeProxy("socks5://127.0.0.1:1080"), null);
  assert.equal(normalizeProxy("ftp://127.0.0.1:21"), null);
  assert.equal(normalizeProxy("invalid-proxy"), null);
});

test("sanitizes proxy passwords in urls", () => {
  assert.equal(
    sanitizeProxy("http://alice:supersecret@198.51.100.1:8080/"),
    "http://alice:******@198.51.100.1:8080/",
  );
  assert.equal(sanitizeProxy("http://198.51.100.1:8080/"), "http://198.51.100.1:8080/");
  assert.equal(sanitizeProxy(""), "");
});

test("loads and deduplicates proxies from env string", () => {
  const env = `
    198.51.100.1:8080
    # comment
    198.51.100.2:8080
    198.51.100.1:8080
  `;
  const list = loadProxies({ env, file: null, root: "/nonexistent" });
  assert.deepEqual(list, [
    "http://198.51.100.1:8080/",
    "http://198.51.100.2:8080/",
  ]);
});

test("handles empty proxy pool gracefully", () => {
  const pool = new ProxyPool({ proxies: [] });
  assert.equal(pool.enabled, false);
  assert.equal(pool.size, 0);
  assert.equal(pool.next(), null);
  assert.equal(pool.acquire(), null);
  const health = pool.health();
  assert.equal(health.enabled, false);
  assert.equal(health.configured, 0);
  assert.equal(health.active, 0);
  assert.equal(health.coolingDownCount, 0);
});

test("rotates proxies sequentially in round-robin mode", () => {
  const pool = new ProxyPool({
    strategy: "round-robin",
    proxies: [
      "198.51.100.1:8080",
      "198.51.100.2:8080",
      "198.51.100.3:8080",
    ],
  });

  assert.equal(pool.enabled, true);
  assert.equal(pool.size, 3);
  assert.equal(pool.next(), "http://198.51.100.1:8080/");
  assert.equal(pool.next(), "http://198.51.100.2:8080/");
  assert.equal(pool.next(), "http://198.51.100.3:8080/");
  assert.equal(pool.next(), "http://198.51.100.1:8080/");
});

test("tracks failures and puts proxy into cooldown after max failures", () => {
  const p1 = "http://198.51.100.1:8080/";
  const p2 = "http://198.51.100.2:8080/";
  const pool = new ProxyPool({
    strategy: "round-robin",
    maxConsecutiveFailures: 2,
    cooldownMs: 5_000,
    proxies: [p1, p2],
  });

  // First failure on p1
  pool.reportFailure(p1, "connection timeout");
  assert.equal(pool.isHealthy(p1), true);

  // Second failure on p1 -> reaches maxConsecutiveFailures -> cooldown!
  pool.reportFailure(p1, "connection refused");
  assert.equal(pool.isHealthy(p1), false);

  // Next requests should skip p1 and return p2
  assert.equal(pool.next(), p2);
  assert.equal(pool.next(), p2);

  // Health report reflects cooldown with sanitized URL
  const health = pool.health();
  assert.equal(health.active, 1);
  assert.equal(health.coolingDownCount, 1);
  assert.equal(health.coolingDown[0].proxy, p1);
  assert.ok(health.coolingDown[0].cooldownRemainingMs > 0);
});

test("immediately cools down proxy on rate limit (429)", () => {
  const p1 = "http://198.51.100.1:8080/";
  const pool = new ProxyPool({
    proxies: [p1],
    cooldownMs: 10_000,
  });

  assert.equal(pool.isHealthy(p1), true);
  pool.reportRateLimited(p1);
  assert.equal(pool.isHealthy(p1), false);
});

test("reportSuccess resets failures and cooldown", () => {
  const p1 = "http://198.51.100.1:8080/";
  const pool = new ProxyPool({
    maxConsecutiveFailures: 1,
    cooldownMs: 10_000,
    proxies: [p1],
  });

  pool.reportFailure(p1);
  assert.equal(pool.isHealthy(p1), false);

  pool.reportSuccess(p1);
  assert.equal(pool.isHealthy(p1), true);
});

test("creates and caches ProxyAgent dispatchers", () => {
  const p1 = "http://198.51.100.1:8080/";
  const pool = new ProxyPool({ proxies: [p1] });

  const agent1 = pool.getDispatcher(p1);
  assert.ok(agent1);
  const agent2 = pool.getDispatcher(p1);
  assert.equal(agent1, agent2); // Caches and reuses same dispatcher

  pool.close();
});

test("ProxyPool random strategy picks items from the pool", () => {
  const proxies = ["198.51.100.1:8080", "198.51.100.2:8080"];
  const pool = new ProxyPool({ strategy: "random", proxies });

  const picked = new Set();
  for (let i = 0; i < 30; i++) {
    picked.add(pool.next());
  }

  for (const p of picked) {
    assert.ok(p.startsWith("http://198.51.100."));
  }
});

test("ProxyPool falls back to raw rotation when all proxies are in cooldown", () => {
  const p1 = "http://198.51.100.1:8080/";
  const pool = new ProxyPool({
    proxies: [p1],
    maxConsecutiveFailures: 1,
    cooldownMs: 60_000,
  });

  pool.reportFailure(p1);
  assert.equal(pool.isHealthy(p1), false);

  const fallback = pool.next();
  assert.equal(fallback, p1);
});

test("ProxyPool reload updates proxies and cleans up removed agents", () => {
  const p1 = "198.51.100.1:8080";
  const p2 = "198.51.100.2:8080";
  const pool = new ProxyPool({ proxies: [p1] });

  const agent1 = pool.getDispatcher(pool.next());
  assert.ok(agent1);

  const health = pool.reload([p2]);
  assert.equal(health.configured, 1);
  assert.equal(pool.next(), "http://198.51.100.2:8080/");
  pool.close();
});
