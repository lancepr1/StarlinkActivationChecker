// proxyPool.js — rotating proxy pool with round-robin/random rotation and failure tracking
const fs = require('fs');
const path = require('path');

function loadProxies() {
  const fromEnv = (process.env.PROXY_LIST || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let fromFile = [];
  const file = path.join(__dirname, 'proxies.txt');
  if (fs.existsSync(file)) {
    fromFile = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }

  // dedupe, keep order (env first)
  return [...new Set([...fromEnv, ...fromFile])];
}

class ProxyPool {
  constructor({ strategy = process.env.PROXY_STRATEGY || 'round-robin' } = {}) {
    this.proxies = loadProxies();
    this.strategy = strategy;
    this.index = 0;
    // failure tracking: proxy -> { failures, cooldownUntil }
    this.stats = new Map();
    this.maxConsecutiveFailures = 3;
    this.cooldownMs = 60_000; // 1 minute in the penalty box
  }

  get enabled() {
    return this.proxies.length > 0;
  }

  // Internal: pick ignoring cooldowns (fallback if everything is cooling down)
  #pickRaw() {
    if (this.strategy === 'random') {
      return this.proxies[Math.floor(Math.random() * this.proxies.length)];
    }
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index = (this.index + 1) % this.proxies.length;
    return proxy;
  }

  // Returns the next healthy proxy, or null if none are configured/available
  next() {
    if (!this.enabled) return null;
    for (let i = 0; i < this.proxies.length; i++) {
      const proxy = this.#pickRaw();
      const s = this.stats.get(proxy);
      const healthy =
        !s || s.failures < this.maxConsecutiveFailures || Date.now() > s.cooldownUntil;
      if (healthy) return proxy;
    }
    // Everything is cooling down — fall back to rotation anyway
    return this.#pickRaw();
  }

  reportSuccess(proxy) {
    this.stats.delete(proxy);
  }

  reportFailure(proxy) {
    const s = this.stats.get(proxy) || { failures: 0, cooldownUntil: 0 };
    s.failures += 1;
    if (s.failures >= this.maxConsecutiveFailures) {
      s.cooldownUntil = Date.now() + this.cooldownMs;
      s.failures = 0; // fresh count when it rejoins
    }
    this.stats.set(proxy, s);
  }

  // Health snapshot, handy for a /proxies/health endpoint
  health() {
    return {
      configured: this.proxies.length,
      strategy: this.strategy,
      coolingDown: [...this.stats.entries()]
        .filter(([, s]) => s.cooldownUntil > Date.now())
        .map(([p]) => p),
    };
  }
}

module.exports = { ProxyPool, loadProxies };