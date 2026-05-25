#!/usr/bin/env node
import http from "node:http";

const socketPath = process.env.PI_CLAUDIFY_SOCKET;
const prompt = process.argv.slice(2).join(" ") || "sudo password:";

if (!socketPath) {
  console.error("PI_CLAUDIFY_SOCKET is not set");
  process.exit(1);
}

const body = JSON.stringify({ prompt });
const req = http.request({
  socketPath,
  path: "/sudo/askpass",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
  timeout: 65_000,
}, (res) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
      console.error(raw || `askpass failed with status ${res.statusCode}`);
      process.exit(1);
    }
    try {
      const data = JSON.parse(raw);
      if (typeof data.password !== "string" || data.password.length === 0) {
        console.error("askpass returned no password");
        process.exit(1);
      }
      process.stdout.write(data.password + "\n");
    } catch (err) {
      console.error("invalid askpass response");
      process.exit(1);
    }
  });
});

req.on("timeout", () => req.destroy(new Error("askpass timed out")));
req.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
req.end(body);
