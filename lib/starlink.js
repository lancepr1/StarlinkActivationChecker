import { solveCaptcha } from "./pow.js";
import { defaultProxyPool } from "./proxyPool.js";

const ORIGIN = "https://starlink.com";
const CAPTCHA_LABEL = 6;

const KIT_LABELS = {
  "PRD_TAG-V2": "Standard V2",
  "PRD_TAG-V3": "Standard V3",
  "PRD_TAG-V4LITE": "Standard V4",
  "PRD_TAG-V4": "Standard V4X",
  "PRD_TAG-V5": "Standard V5",
  "PRD_TAG-MINI1": "Mini",
  "PRD_TAG-HP": "Performance",
  "PRD_TAG-MOBILEHP": "Performance",
  "PRD_TAG-V4HP": "Performance",
  "PRD_TAG-ENTERPRISE1": "Enterprise",
};

function headers(extra = {}) {
  return {
    Accept: "application/json",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/activate`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    ...extra,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: { raw: text.slice(0, 300) } };
  }
}

function errorMessage(body) {
  const message = body?.errors?.[0]?.errorMessage;
  if (typeof message === "string" && message) return message;
  if (typeof body?.raw === "string") return "unexpected_response";
  return "unknown_error";
}

export function labelKitType(kitType) {
  if (kitType == null || kitType === "") return "";
  const value = String(kitType);
  return KIT_LABELS[value] ?? value;
}

export function interpretLookup(status, body) {
  if (status === 429) {
    return { status: "rate_limited", detail: "Starlink rate limited this check. It will be retried." };
  }

  const message = errorMessage(body);
  if (body?.isValid === false || status >= 400) {
    if (message === "invalid_device_id") {
      return { status: "not_recognized", detail: "Starlink does not recognize this identifier." };
    }
    if (/already_assigned|already assigned/i.test(message)) {
      return { status: "activated", detail: "Already assigned on Starlink." };
    }
    if (/captcha|pow|challenge/i.test(message)) {
      return { status: "retry", detail: message };
    }
    return { status: "error", detail: message.replaceAll("_", " ") };
  }

  const content = body?.content ?? body ?? {};
  const deviceId = content?.deviceId ?? null;
  const kitType = labelKitType(content?.kitType);

  if (deviceId == null) {
    return {
      status: "activated",
      kitType,
      detail: "Already assigned. Activation would stop on starlink.com/activate.",
    };
  }

  return {
    status: "available",
    kitType,
    deviceId: String(deviceId),
    detail: "Not assigned. Activation can continue on starlink.com/activate.",
  };
}

async function getChallenge({ dispatcher, timeoutMs = 12_000 } = {}) {
  const fetchOpts = {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(CAPTCHA_LABEL),
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (dispatcher) fetchOpts.dispatcher = dispatcher;

  const response = await fetch(`${ORIGIN}/api/auth/v1/get-captcha`, fetchOpts);
  const { status, body } = await readJson(response);
  if (!body?.isValid || !body.content?.id) {
    const error = new Error(errorMessage(body));
    error.result = interpretLookup(status, body);
    throw error;
  }
  return body.content;
}

async function lookup(identifier, token, { dispatcher, timeoutMs = 12_000 } = {}) {
  const fetchOpts = {
    headers: headers({ "XCaptcha-Token": token }),
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (dispatcher) fetchOpts.dispatcher = dispatcher;

  const response = await fetch(
    `${ORIGIN}/api/webagg/v1/activate/unlocked-utid/${encodeURIComponent(identifier)}`,
    fetchOpts,
  );
  return readJson(response);
}

export async function checkIdentifier(identifier, { pool = defaultProxyPool, timeoutMs = 12_000 } = {}) {
  let last = null;
  const maxAttempts = pool?.enabled ? Math.max(3, Math.min(pool.size, 5)) : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const proxy = pool?.enabled ? pool.next() : null;
    const dispatcher = proxy ? pool.getDispatcher(proxy) : undefined;

    try {
      const challenge = await getChallenge({ dispatcher, timeoutMs });
      const token = solveCaptcha(challenge);
      const { status, body } = await lookup(identifier, token, { dispatcher, timeoutMs });
      const result = interpretLookup(status, body);
      last = result;

      if (result.status === "rate_limited") {
        if (proxy) pool.reportRateLimited(proxy);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      if (result.status === "retry") {
        if (proxy) pool.reportFailure(proxy, "challenge_retry");
        continue;
      }

      if (status === 403) {
        if (proxy) pool.reportFailure(proxy, "forbidden_403");
        continue;
      }

      if (proxy) pool.reportSuccess(proxy);
      return result;
    } catch (err) {
      if (proxy) pool.reportFailure(proxy, err.message);
      last = {
        status: "error",
        detail: err.result?.detail || err.message || "The activation check could not be completed.",
      };
      if (attempt < maxAttempts - 1) {
        continue;
      }
    }
  }

  if (last?.status === "retry" || last?.status === "rate_limited") {
    return { status: "error", detail: last.detail || "The activation check could not be completed." };
  }
  return last ?? { status: "error", detail: "The activation check could not be completed." };
}
