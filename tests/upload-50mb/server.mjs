#!/usr/bin/env node
// Tiny static server for the upload-50mb Gate-3 test page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = "test-page.html";
const pagePath = path.join(__dirname, PAGE);

const args = process.argv.slice(2);
let fixedPort;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1] != null) {
    fixedPort = Number.parseInt(String(args[i + 1]), 10);
    if (!Number.isFinite(fixedPort) || fixedPort < 1 || fixedPort > 65535) {
      console.error("invalid --port");
      process.exit(1);
    }
    i++;
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (u.pathname === "/" || u.pathname === `/${PAGE}`) {
    fs.readFile(pagePath, (err, data) => {
      if (err) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }
  res.writeHead(404).end();
});

const listenOn = fixedPort != null ? fixedPort : 0;
server.listen(listenOn, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : listenOn;
  process.stdout.write(`served-on http://127.0.0.1:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
