#!/usr/bin/env node
import http from 'node:http';

let port = 8766;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) port = Number(process.argv[++i]);
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>Bro Automate local smoke</title>
<h1 id="ready">Bro Automate local smoke</h1>
<p id="status">ready</p>
<p id="count">count: 0</p>
<button id="increment">Increment</button>
<script>
let n = 0;
document.getElementById('increment').addEventListener('click', () => {
  n += 1;
  document.getElementById('count').textContent = 'count: ' + n;
  document.getElementById('status').textContent = 'clicked';
});
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`served-on http://127.0.0.1:${addr.port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
