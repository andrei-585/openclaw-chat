const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const OPENCLAW_BASE_URL = (process.env.OPENCLAW_BASE_URL || "https://openclaw-production-1df1.up.railway.app/v1").replace(/\/+$/, "");
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || "llama3.2:3b";
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || "";
const OPENCLAW_CHAT_PATH = process.env.OPENCLAW_CHAT_PATH || "";

const INDEX_PATH = path.join(__dirname, "index.html");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data)
  });
  res.end(data);
}

function applyCommonHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function unique(values) {
  return [...new Set(values)];
}

function buildUpstreamUrls() {
  const explicitPath = OPENCLAW_CHAT_PATH.trim();
  if (explicitPath) {
    const path = explicitPath.startsWith("/") ? explicitPath : `/${explicitPath}`;
    return [`${OPENCLAW_BASE_URL}${path}`];
  }

  const base = OPENCLAW_BASE_URL;
  const baseNoV1 = base.endsWith("/v1") ? base.slice(0, -3) : base;
  const bases = unique([base, baseNoV1]);
  const paths = ["/chat/completions", "/api/chat/completions", "/v1/chat/completions"];

  const urls = [];
  for (const item of bases) {
    for (const p of paths) {
      urls.push(`${item}${p}`);
    }
  }
  return unique(urls);
}

const server = http.createServer(async (req, res) => {
  applyCommonHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    fs.readFile(INDEX_PATH, "utf8", (err, html) => {
      if (err) {
        sendJson(res, 500, { error: "Failed to load index.html" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });
      res.end(html);
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "openclaw-chat-proxy",
      model: OPENCLAW_MODEL,
      upstreamBase: OPENCLAW_BASE_URL
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat/completions") {
    let clientPayload;
    try {
      clientPayload = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    if (!Array.isArray(clientPayload.messages)) {
      sendJson(res, 400, { error: "messages must be an array" });
      return;
    }

    const upstreamBody = {
      model: clientPayload.model || OPENCLAW_MODEL,
      stream: clientPayload.stream !== false,
      messages: clientPayload.messages
    };

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json"
    };
    if (OPENCLAW_API_KEY) {
      headers.Authorization = `Bearer ${OPENCLAW_API_KEY}`;
    }

    try {
      const tried = [];
      const urls = buildUpstreamUrls();

      for (const url of urls) {
        let upstream;
        try {
          upstream = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(upstreamBody),
            redirect: "manual"
          });
        } catch (err) {
          tried.push({ url, status: "network_error", details: err instanceof Error ? err.message : String(err) });
          continue;
        }

        if (upstream.status === 404) {
          tried.push({ url, status: 404 });
          continue;
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          const location = upstream.headers.get("location");
          sendJson(res, upstream.status || 502, {
            error: `Upstream API error ${upstream.status}`,
            details: text || "Unknown upstream error",
            location: location || undefined,
            tried
          });
          return;
        }

        if (!upstream.body) {
          sendJson(res, 502, {
            error: "Upstream response has no body",
            tried
          });
          return;
        }

        res.statusCode = upstream.status;
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      }

      sendJson(res, 502, {
        error: "No working upstream chat endpoint found",
        details: "All known chat/completions paths returned 404 or network errors",
        tried
      });
    } catch (err) {
      sendJson(res, 502, {
        error: "Failed to reach upstream API",
        details: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
