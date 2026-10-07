import { identifierKind, isValidIdentifier, parseIdentifiers } from "/identifiers.js";

const MAX_CHECKS = 200;
const CONCURRENCY = 1;
const DELAY_MS = 600;

const input = document.querySelector("#identifiers");
const parseSummary = document.querySelector("#parse-summary");
const limitNote = document.querySelector("#limit-note");
const checkButton = document.querySelector("#check");
const stopButton = document.querySelector("#stop");
const clearButton = document.querySelector("#clear");
const exportButton = document.querySelector("#export");
const stats = document.querySelector("#stats");
const progress = document.querySelector("#progress");
const progressBar = document.querySelector("#progress-bar");
const progressLabel = document.querySelector("#progress-label");
const empty = document.querySelector("#empty");
const table = document.querySelector("#table");
const rows = document.querySelector("#rows");

const STATUS_LABELS = {
  queued: "Queued",
  checking: "Checking",
  available: "Available",
  activated: "Already activated",
  not_recognized: "Not recognized",
  invalid_format: "Invalid format",
  error: "Error",
  stopped: "Not checked",
  rate_limited: "Rate limited",
};

let runToken = 0;
let latestRows = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parsedInput() {
  return parseIdentifiers(input.value);
}

function refreshParseSummary() {
  const { identifiers, duplicates } = parsedInput();
  if (!input.value.trim()) {
    parseSummary.textContent = "Nothing pasted yet";
    limitNote.hidden = true;
    return;
  }
  const valid = identifiers.filter(isValidIdentifier).length;
  const extra = duplicates ? `, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : "";
  const matchLabel = valid === 1 ? "1 matches" : valid === 0 ? "None match" : `${valid} match`;
  parseSummary.textContent = `${identifiers.length} unique identifier${identifiers.length === 1 ? "" : "s"}${extra}. ${matchLabel} the activation page format.`;
  if (identifiers.length > MAX_CHECKS) {
    limitNote.hidden = false;
    limitNote.textContent = `Only the first ${MAX_CHECKS} are checked per run.`;
  } else {
    limitNote.hidden = true;
  }
}

input.addEventListener("input", refreshParseSummary);

function setBusy(busy) {
  checkButton.hidden = busy;
  stopButton.hidden = !busy;
  input.disabled = busy;
  clearButton.disabled = busy;
}

function renderStats(list) {
  const counts = new Map();
  for (const row of list) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const order = ["available", "activated", "not_recognized", "invalid_format", "rate_limited", "error", "checking", "queued", "stopped"];
  stats.hidden = list.length === 0;
  stats.replaceChildren(
    ...order
      .filter((key) => counts.has(key))
      .map((key) => {
        const item = document.createElement("span");
        item.className = "stat";
        const count = document.createElement("strong");
        count.textContent = String(counts.get(key));
        item.append(count, ` ${(STATUS_LABELS[key] ?? key).toLowerCase()}`);
        return item;
      }),
  );
}

function renderRows(list) {
  latestRows = list;
  empty.hidden = list.length > 0;
  table.hidden = list.length === 0;
  exportButton.disabled = !list.some((row) => row.status !== "queued" && row.status !== "checking");
  rows.replaceChildren(
    ...list.map((row) => {
      const tr = document.createElement("tr");
      const cells = ["mono", "", "", "", ""].map((className, index) => {
        const td = document.createElement("td");
        if (className) td.className = className;
        if (index === 2) {
          const badge = document.createElement("span");
          badge.className = `badge ${row.status}`;
          badge.textContent = STATUS_LABELS[row.status] ?? row.status;
          td.append(badge);
        }
        return td;
      });
      cells[0].textContent = row.identifier;
      cells[1].textContent = row.kind;
      cells[3].textContent = row.kitType || "—";
      cells[4].textContent = row.detail || "";
      tr.append(...cells);
      return tr;
    }),
  );
  renderStats(list);
}

async function checkOne(identifier, token, retries = 3, backoff = 1000) {
  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier }),
    });

    if (token !== runToken) return null;

    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get("Retry-After");
      const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff;
      await sleep(waitTime);
      return checkOne(identifier, token, retries - 1, backoff * 2);
    }

    const body = await response.json().catch(() => ({
      status: "error",
      detail: "The checker returned an unreadable response.",
    }));

    return {
      status: body.status || "error",
      kitType: body.kitType || "",
      detail: body.detail || "",
      deviceId: body.deviceId || "",
    };
  } catch (err) {
    if (retries > 0 && token === runToken) {
      await sleep(backoff);
      return checkOne(identifier, token, retries - 1, backoff * 2);
    }
    throw err;
  }
}

async function runChecks() {
  const { identifiers } = parsedInput();
  const batch = identifiers.slice(0, MAX_CHECKS);
  if (!batch.length) return;

  const token = ++runToken;
  const list = batch.map((identifier) => ({
    identifier,
    kind: isValidIdentifier(identifier) ? identifierKind(identifier) : "Unknown",
    status: isValidIdentifier(identifier) ? "queued" : "invalid_format",
    kitType: "",
    detail: isValidIdentifier(identifier) ? "" : "This does not match a Starlink kit ID, IMEI, or terminal ID.",
    deviceId: "",
  }));

  setBusy(true);
  progress.hidden = false;
  progressLabel.hidden = false;
  renderRows(list);

  const queue = list.map((row, index) => ({ row, index })).filter(({ row }) => row.status === "queued");
  let finished = list.length - queue.length;
  const total = list.length;

  function paintProgress() {
    progressBar.style.width = `${Math.round((finished / total) * 100)}%`;
    progressLabel.textContent = finished === total ? `Checked ${total}` : `Checking ${finished + 1} of ${total}`;
  }
  paintProgress();

  async function worker() {
    while (token === runToken) {
      const next = queue.shift();
      if (!next) return;

      next.row.status = "checking";
      next.row.detail = "Looking up this identifier on starlink.com/activate.";
      renderRows(list);

      try {
        const result = await checkOne(next.row.identifier, token);
        if (!result || token !== runToken) return;
        Object.assign(next.row, result);
      } catch {
        if (token !== runToken) return;
        next.row.status = "error";
        next.row.detail = "The check request failed.";
      }

      finished += 1;
      paintProgress();
      renderRows(list);

      if (queue.length > 0 && token === runToken) {
        await sleep(DELAY_MS);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (token !== runToken) return;
  progressLabel.textContent = `Checked ${finished} of ${total}`;
  setBusy(false);
  refreshProxyStatus();
}

checkButton.addEventListener("click", () => {
  runChecks();
});

input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runChecks();
  }
});

stopButton.addEventListener("click", () => {
  runToken += 1;
  setBusy(false);
  progressLabel.textContent = "Stopped. Finished rows are kept.";
  for (const row of latestRows) {
    if (row.status === "queued" || row.status === "checking") {
      row.status = "stopped";
      row.detail = "Stopped before this identifier was checked.";
    }
  }
  renderRows(latestRows);
});

clearButton.addEventListener("click", () => {
  input.value = "";
  latestRows = [];
  renderRows([]);
  progress.hidden = true;
  progressLabel.hidden = true;
  refreshParseSummary();
});

exportButton.addEventListener("click", () => {
  const header = ["identifier", "type", "status", "kit", "deviceId", "detail"];
  const lines = [header.join(",")];
  for (const row of latestRows) {
    if (row.status === "queued" || row.status === "checking") continue;
    const cells = [row.identifier, row.kind, STATUS_LABELS[row.status] ?? row.status, row.kitType, row.deviceId, row.detail];
    lines.push(cells.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "starlink-activation-check.csv";
  link.click();
  URL.revokeObjectURL(link.href);
});

const proxyPill = document.querySelector("#proxy-pill");

async function refreshProxyStatus() {
  if (!proxyPill) return;
  try {
    const res = await fetch("/api/proxies");
    if (!res.ok) return;
    const data = await res.json();
    if (data.enabled) {
      const cooling = data.coolingDownCount || 0;
      if (cooling > 0) {
        proxyPill.className = "proxy-pill warning";
        proxyPill.title = `${data.active} of ${data.configured} proxies healthy (${cooling} cooling down)`;
        proxyPill.innerHTML = `<span class="dot"></span> ${data.active}/${data.configured} Proxies`;
      } else {
        proxyPill.className = "proxy-pill active";
        proxyPill.title = `${data.configured} rotating proxies active (${data.strategy})`;
        proxyPill.innerHTML = `<span class="dot"></span> ${data.configured} Proxies`;
      }
    } else {
      proxyPill.className = "proxy-pill direct";
      proxyPill.title = "No proxies configured (direct connection). Add proxies to proxies.txt or PROXY_LIST env var.";
      proxyPill.innerHTML = `<span class="dot"></span> Direct Connection`;
    }
  } catch {
    // Keep quiet on connection issues
  }
}

refreshParseSummary();
refreshProxyStatus();
