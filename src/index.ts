import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

server.listen(port, host, () => {
  console.log(`server listening on http://${host}:${port}`);
});
