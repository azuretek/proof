// Proof capture harness for the staged-media ownership boundary routes.
//
// Emits one PNG per phase, plus a redacted raw log that records every request and
// response the phase made, as one JSON line and one readable line per case.
// Run it against a gateway booted from the revision under test; seed-fixture.sh
// writes the fixture it expects.
//
// Environment (all optional except TOKEN):
//   PORT         gateway HTTP port        default 19001
//   TOKEN        gateway auth token       required, never logged
//   AGENT        agent id                 default dev
//   OWNER        session key that owns the staged object
//   STATE        gateway state directory  default /srv/openclaw-proof/state
//   OUT          proof output directory   default /srv/proof/151138
//   LOG          raw log path             default <OUT>/capture.log
//   PHASE        boundary | unreadable    default boundary
//   REV, BRANCH, ENVIRONMENT              recorded in the log header

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 19001);
const TOKEN = process.env.TOKEN || "";
const AGENT = process.env.AGENT || "dev";
const OWNER = process.env.OWNER || "";
const STATE = process.env.STATE || "/srv/openclaw-proof/state";
const OUT = process.env.OUT || "/srv/proof/151138";
const REV = process.env.REV || "unknown";
const BRANCH = process.env.BRANCH || "unknown";
const PHASE = process.env.PHASE || "boundary";
const LOG = process.env.LOG || path.join(OUT, "capture-" + PHASE + ".log");
const ENVIRONMENT =
  process.env.ENVIRONMENT ||
  "Linux VM, Ubuntu 24.04, x86_64, 4 vCPU, on a build host; gateway bound to loopback";

const INBOUND = path.join(STATE, "media", "inbound");
const ROUTE_PATH = "/__openclaw__/assistant-media";
const ORIGIN = "http://127.0.0.1:" + PORT;
const ROUTE = ORIGIN + ROUTE_PATH;

const OWNED_REF = "media://inbound/owned-staged.png";
const FRESH_REF = "media://inbound/fresh-staged.png";
const CONTROL_REF = "media://inbound/unstaged-control.png";
const OWNED_PATH = path.join(INBOUND, "owned-staged.png");
const OWNED_FILE_URL = "file://" + path.join(INBOUND, "owned-staged.png");

const CASES = {
  boundary: [
    {
      label: "staged object, owner bound, owning session named",
      source: OWNED_REF,
      session: OWNER,
      bytes: true,
    },
    { label: "staged object, owner bound, no session named", source: OWNED_REF, session: null },
    { label: "same object by absolute path, no session named", source: OWNED_PATH, session: null },
    { label: "same object by file URL, no session named", source: OWNED_FILE_URL, session: null },
    {
      label: "freshly staged object, no owner bound, no session named",
      source: FRESH_REF,
      session: null,
    },
    { label: "control: never-staged object, no session named", source: CONTROL_REF, session: null },
    {
      label: "control: absolute path, owning session named",
      source: OWNED_PATH,
      session: OWNER,
      bytes: true,
    },
  ],
  unreadable: [
    {
      label: "staged object, owner bound, owning session named",
      source: OWNED_REF,
      session: OWNER,
    },
    {
      label: "freshly staged object, no owner bound, no session named",
      source: FRESH_REF,
      session: null,
    },
    { label: "never-staged object, no session named", source: CONTROL_REF, session: null },
  ],
};

const cases = CASES[PHASE];
if (!cases) throw new Error("unknown PHASE: " + PHASE);
if (!TOKEN) throw new Error("TOKEN is required");

// Redaction is applied in code, before any value can reach the log.
const redactUrl = (value) =>
  value
    .replace(/([?&]mediaTicket=)[^&]*/gu, "$1<redacted>")
    .replace(/([?&]token=)[^&]*/gu, "$1<redacted>");
const redactBody = (value) =>
  value
    .replace(/("mediaTicket"\s*:\s*")[^"]*(")/gu, "$1<redacted>$2")
    .replace(/("mediaTicketExpiresAt"\s*:\s*")[^"]*(")/gu, "$1<redacted>$2");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
  deviceScaleFactor: 2,
  extraHTTPHeaders: { Authorization: "Bearer " + TOKEN },
});
const page = await context.newPage();
await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

const results = await page.evaluate(
  async (input) => {
    const redact = (value) =>
      value
        .replace(/([?&]mediaTicket=)[^&]*/gu, "$1<redacted>")
        .replace(/([?&]token=)[^&]*/gu, "$1<redacted>");
    const toBase64 = (bytes) => {
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    };
    const readResponse = async (url) => {
      const response = await fetch(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: bytes,
        base64: toBase64(bytes),
        text: new TextDecoder().decode(bytes),
      };
    };
    const buildMetaUrl = (row) => {
      const query = new URLSearchParams();
      query.set("source", row.source);
      query.set("meta", "1");
      query.set("agentId", input.agent);
      if (row.session) query.set("sessionKey", row.session);
      return input.route + "?" + query.toString();
    };
    const buildBytesUrl = (row, ticket) => {
      const query = new URLSearchParams();
      query.set("source", row.source);
      query.set("agentId", input.agent);
      if (row.session) query.set("sessionKey", row.session);
      query.set("mediaTicket", ticket);
      return input.route + "?" + query.toString();
    };

    const output = [];
    for (const row of input.rows) {
      const metaUrl = buildMetaUrl(row);
      const meta = await readResponse(metaUrl);
      const entry = {
        label: row.label,
        source: row.source,
        session: row.session || null,
        sessionNamed: Boolean(row.session),
        requestUrl: redact(metaUrl),
        status: meta.status,
        contentType: meta.contentType,
        contentLength: meta.bytes.length,
        bodyBase64: meta.base64,
        bodyText:
          meta.contentType && meta.contentType.indexOf("application/json") !== -1
            ? meta.text
            : null,
        bytes: null,
      };
      if (row.bytes && meta.status === 200) {
        const metaBody = JSON.parse(meta.text);
        const ticket = String(metaBody.mediaTicket || "");
        const bytesUrl = buildBytesUrl(row, ticket);
        const served = await readResponse(bytesUrl);
        entry.bytes = {
          requestUrl: redact(bytesUrl),
          status: served.status,
          contentType: served.contentType,
          contentLength: served.bytes.length,
          bodyBase64: served.base64,
          previewDataUrl:
            "data:" +
            (served.contentType || "application/octet-stream") +
            ";base64," +
            served.base64,
        };
      }
      output.push(entry);
    }
    return output;
  },
  {
    rows: cases.map((row) => ({
      label: row.label,
      source: row.source,
      session: row.session || null,
      bytes: Boolean(row.bytes),
    })),
    route: ROUTE,
    agent: AGENT,
  },
);

const redacted = results.map((entry) =>
  Object.assign({}, entry, {
    bodyText: entry.bodyText === null ? null : redactBody(entry.bodyText),
  }),
);

await page.evaluate(
  (input) => {
    const rows = input.rows;
    const meta = input.meta;
    document.open();
    document.write("<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>");
    document.close();
    document.body.style.cssText =
      "margin:0;padding:26px 30px;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff";
    const head = document.createElement("div");
    const title = document.createElement("div");
    title.style.cssText = "font-size:20px;font-weight:650;margin-bottom:4px";
    title.textContent = "Staged-media ownership boundary: gateway HTTP responses";
    const sub1 = document.createElement("div");
    sub1.style.cssText = "font-size:13px;color:#444;margin-bottom:2px";
    sub1.textContent =
      "Gateway booted from branch " +
      meta.branch +
      " at " +
      meta.rev.slice(0, 12) +
      ", route " +
      meta.route;
    const sub2 = document.createElement("div");
    sub2.style.cssText = "font-size:13px;color:#444;margin-bottom:16px";
    sub2.textContent =
      meta.environment +
      ". Responses read live in the browser over loopback; mediaTicket values redacted. Raw log: " +
      meta.logPath;
    head.appendChild(title);
    head.appendChild(sub1);
    head.appendChild(sub2);
    document.body.appendChild(head);

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;font-size:14px";
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr style='text-align:left;border-bottom:2px solid #111'><th style='padding:6px 8px'>Case</th><th style='padding:6px 8px'>Source addressed</th><th style='padding:6px 8px'>Session named</th><th style='padding:6px 8px'>Result</th></tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    document.body.appendChild(table);

    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.style.cssText = "border-bottom:1px solid #ddd;vertical-align:top";
      const tdCase = document.createElement("td");
      tdCase.style.cssText = "padding:7px 8px;font-weight:600";
      tdCase.textContent = row.label;
      const tdSource = document.createElement("td");
      tdSource.style.cssText =
        "padding:7px 8px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all";
      tdSource.textContent = row.source;
      const tdSession = document.createElement("td");
      tdSession.style.cssText =
        "padding:7px 8px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all";
      tdSession.textContent = row.session || "none";
      const tdResult = document.createElement("td");
      tdResult.style.cssText = "padding:7px 8px";
      const status = document.createElement("span");
      status.style.cssText = "font-weight:700;color:" + (row.status === 200 ? "#0a6" : "#b00");
      status.textContent = String(row.status);
      tdResult.appendChild(status);
      const detail = document.createElement("div");
      detail.style.cssText =
        "font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#333;word-break:break-all";
      detail.textContent = row.bodyText || "<binary response body, see the log>";
      tdResult.appendChild(detail);
      if (row.bytes) {
        const served = document.createElement("div");
        served.style.cssText = "font-size:12.5px;color:#333;margin-top:2px";
        served.textContent =
          "served bytes: " +
          row.bytes.status +
          " " +
          row.bytes.contentType +
          " " +
          row.bytes.contentLength +
          " bytes";
        tdResult.appendChild(served);
        const img = document.createElement("img");
        img.src = row.bytes.previewDataUrl;
        img.style.cssText =
          "width:56px;height:56px;margin-top:3px;border:1px solid #999;image-rendering:pixelated";
        tdResult.appendChild(img);
      }
      tr.appendChild(tdCase);
      tr.appendChild(tdSource);
      tr.appendChild(tdSession);
      tr.appendChild(tdResult);
      tbody.appendChild(tr);
    }
  },
  {
    rows: redacted,
    meta: { branch: BRANCH, rev: REV, route: ROUTE_PATH, environment: ENVIRONMENT, logPath: LOG },
  },
);

const lines = [];
lines.push("# staged-media ownership boundary: raw capture log");
lines.push("# revision: " + REV);
lines.push("# branch: " + BRANCH);
lines.push("# phase: " + PHASE);
lines.push("# route: " + ROUTE_PATH);
lines.push("# environment: " + ENVIRONMENT);
lines.push("# auth: every request carries an Authorization header; its value is never logged");
lines.push(
  "# redaction: mediaTicket, mediaTicketExpiresAt and any token query value become <redacted>",
);
lines.push("# generated_at: " + new Date().toISOString());
lines.push("");

for (const entry of results) {
  const bodyBytes = Buffer.from(entry.bodyBase64, "base64");
  const bodyText = entry.bodyText === null ? null : redactBody(entry.bodyText);
  const record = {
    phase: PHASE,
    case: entry.label,
    source: entry.source,
    sessionNamed: entry.sessionNamed,
    session: entry.session,
    request: { url: entry.requestUrl },
    response: {
      status: entry.status,
      contentType: entry.contentType,
      contentLength: entry.contentLength,
      sha256: sha256(bodyBytes),
      body: bodyText === null ? "<binary, see served bytes>" : bodyText,
    },
  };
  if (entry.bytes) {
    const servedBytes = Buffer.from(entry.bytes.bodyBase64, "base64");
    record.servedBytes = {
      request: { url: entry.bytes.requestUrl },
      status: entry.bytes.status,
      contentType: entry.bytes.contentType,
      contentLength: entry.bytes.contentLength,
      sha256: sha256(servedBytes),
    };
  }
  lines.push(JSON.stringify(record));
  lines.push("CASE " + entry.label);
  lines.push("  request-url: " + entry.requestUrl);
  lines.push("  session-named: " + (entry.sessionNamed ? "yes (" + entry.session + ")" : "no"));
  lines.push("  http-status: " + entry.status);
  lines.push("  content-type: " + entry.contentType);
  lines.push("  content-length: " + entry.contentLength);
  lines.push("  body-sha256: " + sha256(bodyBytes));
  if (bodyText !== null) lines.push("  body: " + bodyText);
  if (entry.bytes) {
    const servedBytes = Buffer.from(entry.bytes.bodyBase64, "base64");
    lines.push("  served-bytes-url: " + entry.bytes.requestUrl);
    lines.push(
      "  served-bytes: " +
        entry.bytes.status +
        " " +
        entry.bytes.contentType +
        " " +
        entry.bytes.contentLength +
        " bytes sha256=" +
        sha256(servedBytes),
    );
  }
  lines.push("");
}

const logText = lines.join("\n") + "\n";

// Fail closed: never write a log that carries a credential or a ticket value.
const forbidden = [
  {
    name: "an authorization header value",
    pattern: /Bearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]{16,}/u,
  },
  { name: "a ticket query value", pattern: /mediaTicket=(?!<redacted>)[A-Za-z0-9._~+/%=:-]{16,}/u },
  { name: "an unredacted ticket field", pattern: /"mediaTicket"\s*:\s*"(?!<redacted>)/u },
  { name: "a token query value", pattern: /[?&]token=(?!<redacted>)[A-Za-z0-9._-]{16,}/u },
];
for (const check of forbidden) {
  if (check.pattern.test(logText))
    throw new Error("refusing to write the log: it holds " + check.name);
}
if (logText.includes(TOKEN)) throw new Error("refusing to write the log: it holds the auth token");

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.dirname(LOG), { recursive: true });
await fs.writeFile(LOG, logText, "utf8");

const png = path.join(
  OUT,
  PHASE === "unreadable" ? "2-unreadable-registry.png" : "1-ownership-boundary.png",
);
await page.screenshot({ path: png, fullPage: true });
await browser.close();

console.log("PNG " + png);
console.log("LOG " + LOG + " (" + results.length + " cases)");
