import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidIdentifier } from "./lib/identifiers.js";
import { checkIdentifier } from "./lib/starlink.js";
import { defaultProxyPool } from "./lib/proxyPool.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT) || 8787;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8_000) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

async function serveStatic(response, pathname) {
  if (pathname === "/identifiers.js") {
    const file = await readFile(join(root, "lib", "identifiers.js"));
    send(response, 200, file, types[".js"]);
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  try {
    const file = await readFile(filePath);
    send(response, 200, file, types[extname(filePath)] ?? "application/octet-stream");
  } catch {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/api/proxies") {
    send(response, 200, JSON.stringify(defaultProxyPool.health()));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/proxies/reload") {
    const health = defaultProxyPool.reload();
    send(response, 200, JSON.stringify({ message: "Proxies reloaded", health }));
    return;
  }

  if (request.method === "GET") {
    await serveStatic(response, url.pathname);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/check") {
    try {
      const body = await readBody(request);
      const identifier = String(body.identifier ?? "").trim();
      if (!identifier || identifier.length > 64) {
        send(response, 400, JSON.stringify({ status: "invalid_format", detail: "Enter a kit ID, IMEI, or terminal ID." }));
        return;
      }
      if (!isValidIdentifier(identifier)) {
        send(response, 200, JSON.stringify({
          status: "invalid_format",
          detail: "This does not match a Starlink kit ID, IMEI, or terminal ID.",
        }));
        return;
      }
      const result = await checkIdentifier(identifier);
      send(response, 200, JSON.stringify(result));
    } catch (error) {
      console.error(error);
      const status = error.status ?? 502;
      send(response, status, JSON.stringify({
        status: "error",
        detail: status === 400 || status === 413 ? error.message : "Could not reach the Starlink activation check.",
      }));
    }
    return;
  }

  send(response, 404, JSON.stringify({ status: "error", detail: "Not found" }));
});

server.listen(port, "127.0.0.1", () => {
  const health = defaultProxyPool.health();
  const proxyMsg = health.enabled
    ? `${health.configured} proxies loaded (${health.strategy})`
    : "direct connection (no proxies)";
  console.log(`Activation check running at http://127.0.0.1:${port} [${proxyMsg}]`);
});
