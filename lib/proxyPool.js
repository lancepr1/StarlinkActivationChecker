import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Normalizes proxy strings from various common formats:
 * - http://host:port
 * - https://host:port
 * - http://user:pass@host:port
 * - host:port -> http://host:port
 * - host:port:user:pass -> http://user:pass@host:port
 * - user:pass@host:port -> http://user:pass@host:port
 */
export function normalizeProxy(raw) {
  if (!raw || typeof raw !== "string") return null;
  let str = raw.trim();
  if (!str || str.startsWith("#")) return null;

  // Format: host:port:user:pass
  const hpup = /^([a-zA-Z0-9.-]+):(\d+):([^:]+):(.+)$/.exec(str);
  if (hpup) {
    const [, host, port, user, pass] = hpup;
    str = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(str)) {
    // If a scheme is already present, ensure it is http or https
    if (!/^https?:\/\//i.test(str)) {
      return null;
    }
  } else if (/:\d+$/.test(str) || /@.+:\d+$/.test(str)) {
    // Format without protocol must include a port: e.g. host:port or user:pass@host:port
    str = `http://${str}`;
  } else {
    return null;
  }

  try {
    const parsed = new URL(str);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Strips password for safe logging and metrics.
 */
export function sanitizeProxy(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== "string") return "";
  try {
    const url = new URL(proxyUrl);
    if (url.password) {
      url.password = "******";
    }
    return url.href;
  } catch {
    return proxyUrl;
  }
}

/**
 * Loads proxies from environment variables and proxy files.
 */
export function loadProxies({ env = process.env.PROXY_LIST, file = process.env.PROXY_FILE, root = rootDir } = {}) {
  const fromEnv = (env || "")
    .split(/[\n,]+/)
    .map(normalizeProxy)
    .filter(Boolean);

  const candidateFiles = [
    file,
    path.join(root, "proxies.txt"),
    path.join(root, "lib", "proxies.txt"),
  ].filter(Boolean);

  let fromFile = [];
  for (const candidate of candidateFiles) {
    if (fs.existsSync(candidate)) {
      try {
        const lines = fs
          .readFileSync(candidate, "utf8")
          .split(/\r?\n/)
          .map(normalizeProxy)
          .filter(Boolean);
        fromFile = lines;
        break;
      } catch (err) {
        console.error(`Failed to read proxy file ${candidate}:`, err.message);
      }
    }
  }

  // Deduplicate while preserving order (env first)
  return [...new Set([...fromEnv, ...fromFile])];
}

export class ProxyPool {
  constructor({
    strategy = process.env.PROXY_STRATEGY || "round-robin",
    maxConsecutiveFailures = Number(process.env.PROXY_MAX_FAILURES) || 3,
    cooldownMs = Number(process.env.PROXY_COOLDOWN_MS) || 60_000,
    proxies = null,
  } = {}) {
    this.strategy = strategy;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.cooldownMs = cooldownMs;
    this.index = 0;
    this.stats = new Map();
    this.agents = new Map();
    this.proxies = proxies ? proxies.map(normalizeProxy).filter(Boolean) : loadProxies();
  }

  get enabled() {
    return this.proxies.length > 0;
  }

  get size() {
    return this.proxies.length;
  }

  #pickRaw() {
    if (this.proxies.length === 0) return null;
    if (this.strategy === "random") {
      return this.proxies[Math.floor(Math.random() * this.proxies.length)];
    }
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index = (this.index + 1) % this.proxies.length;
    return proxy;
  }

  isHealthy(proxy) {
    if (!proxy) return false;
    const s = this.stats.get(proxy);
    if (!s) return true;
    if (Date.now() < s.cooldownUntil) return false;
    return s.failures < this.maxConsecutiveFailures;
  }

  next() {
    if (!this.enabled) return null;

    for (let i = 0; i < this.proxies.length; i++) {
      const proxy = this.#pickRaw();
      if (this.isHealthy(proxy)) {
        return proxy;
      }
    }

    // All proxies are currently in cooldown — fallback to rotation anyway
    return this.#pickRaw();
  }

  getDispatcher(proxy) {
    if (!proxy) return undefined;
    let agent = this.agents.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      this.agents.set(proxy, agent);
    }
    return agent;
  }

  acquire() {
    const proxy = this.next();
    if (!proxy) return null;
    return {
      proxy,
      dispatcher: this.getDispatcher(proxy),
    };
  }

  reportSuccess(proxy) {
    if (!proxy) return;
    const s = this.stats.get(proxy) || { failures: 0, cooldownUntil: 0, totalSuccess: 0, totalFailures: 0 };
    s.failures = 0;
    s.cooldownUntil = 0;
    s.totalSuccess = (s.totalSuccess || 0) + 1;
    s.lastError = null;
    this.stats.set(proxy, s);
  }

  reportFailure(proxy, reason = null) {
    if (!proxy) return;
    const s = this.stats.get(proxy) || { failures: 0, cooldownUntil: 0, totalSuccess: 0, totalFailures: 0 };
    s.failures += 1;
    s.totalFailures = (s.totalFailures || 0) + 1;
    s.lastError = reason ? String(reason) : null;
    if (s.failures >= this.maxConsecutiveFailures) {
      s.cooldownUntil = Date.now() + this.cooldownMs;
      s.failures = 0; // Fresh count when it rejoins after cooldown
    }
    this.stats.set(proxy, s);
  }

  reportRateLimited(proxy) {
    if (!proxy) return;
    const s = this.stats.get(proxy) || { failures: 0, cooldownUntil: 0, totalSuccess: 0, totalFailures: 0 };
    s.totalFailures = (s.totalFailures || 0) + 1;
    s.lastError = "rate_limited";
    s.cooldownUntil = Date.now() + this.cooldownMs;
    s.failures = 0;
    this.stats.set(proxy, s);
  }

  reload(proxies = null) {
    this.proxies = proxies ? proxies.map(normalizeProxy).filter(Boolean) : loadProxies();
    this.index = 0;

    // Clean up agents for removed proxies
    const currentSet = new Set(this.proxies);
    for (const [key, agent] of this.agents.entries()) {
      if (!currentSet.has(key)) {
        try {
          agent.close?.();
        } catch {}
        this.agents.delete(key);
      }
    }

    return this.health();
  }

  close() {
    for (const agent of this.agents.values()) {
      try {
        agent.close?.();
      } catch {}
    }
    this.agents.clear();
  }

  health() {
    const now = Date.now();
    const coolingDown = [];
    const active = [];

    for (const p of this.proxies) {
      const s = this.stats.get(p);
      const isCooling = s && s.cooldownUntil > now;
      if (isCooling) {
        coolingDown.push({
          proxy: sanitizeProxy(p),
          cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
          lastError: s.lastError ?? null,
        });
      } else {
        active.push(sanitizeProxy(p));
      }
    }

    return {
      enabled: this.enabled,
      configured: this.proxies.length,
      active: active.length,
      coolingDownCount: coolingDown.length,
      strategy: this.strategy,
      coolingDown,
    };
  }
}

export const defaultProxyPool = new ProxyPool();
