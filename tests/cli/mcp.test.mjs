// Fast tests for `hme mcp`. None of these run a full-video tool
// call: the Seg4 compare over MCP is checked by the VERIFY run
// (u6-mcp-compare.json), not here. These tests cover the protocol
// surface and the pure pieces: initialize, tools/list, resources,
// argument validation, summaries, and one real end-to-end tool call
// (context, which is fast) whose report must match the CLI exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOURCES,
  TOOL_NAMES,
  buildSummary,
  listTools,
  readResource,
  validateToolArgs,
} from "../../src/cli/mcp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HME = join(ROOT, "src", "cli", "hme.mjs");

// Run the server with the given request lines on stdin and return
// the parsed response lines. spawnSync closes stdin, so the server
// exits on its own; a hang here would fail the test, not hang the run.
function runServer(requests) {
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const r = spawnSync(process.execPath, [HME, "mcp"], { input, encoding: "utf8" });
  assert.equal(r.status, 0, `server exited ${r.status}: ${r.stderr}`);
  // Stdout must be pure JSON-RPC lines. Stderr may carry diagnostics
  // forwarded from a child CLI run; that is allowed, stdout is the protocol.
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

test("mcp lists exactly the 8 implemented tools, no placeholders", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), ["compare", "context", "control", "diagnose", "extract", "fonts", "player-pass", "trace"]);
  for (const name of ["render", "validate", "gates"]) assert.ok(!TOOL_NAMES.includes(name), `${name} is a placeholder and must have no tool`);
  const tools = listTools();
  assert.equal(tools.length, 8);
  for (const t of tools) {
    assert.equal(typeof t.name, "string");
    assert.ok(t.description.length > 0, `${t.name} needs a description`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(Array.isArray(t.inputSchema.required), `${t.name} needs a required list`);
  }
  assert.deepEqual(listTools().find((t) => t.name === "compare").inputSchema.required, ["ref", "ours"]);
});

test("mcp lists exactly the 4 resources", () => {
  assert.deepEqual(RESOURCES.map((r) => r.uri).sort(), ["hme://ceiling", "hme://predicate", "hme://rules/map", "hme://schema/scene"]);
  for (const r of RESOURCES) assert.equal(r.mimeType, "application/json");
});

test("initialize returns the client protocol version and hme server info", () => {
  const [res] = runServer([INIT]);
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.equal(res.result.serverInfo.name, "hme");
  assert.equal(res.result.serverInfo.version, "0.1.0");
  assert.ok("tools" in res.result.capabilities);
  assert.ok("resources" in res.result.capabilities);
});

test("tools/list and resources/list answer over stdio", () => {
  const [, tools, resources] = runServer([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "resources/list" },
  ]);
  assert.equal(tools.id, 2);
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  assert.equal(resources.id, 3);
  assert.deepEqual(resources.result.resources.map((r) => r.uri).sort(), RESOURCES.map((r) => r.uri).sort());
});

test("ping answers with an empty result and a notification gets no reply", () => {
  const out = runServer([
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 9, method: "ping" },
  ]);
  assert.equal(out.length, 2, "the notification must not produce a response line");
  assert.equal(out[1].id, 9);
  assert.deepEqual(out[1].result, {});
});

test("unknown method is a -32601 error and a bad line is a -32700 error", () => {
  const out = runServer([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/delete" },
  ]);
  assert.equal(out[1].error.code, -32601);
  const r = spawnSync(process.execPath, [HME, "mcp"], { input: "not json\n", encoding: "utf8" });
  assert.equal(r.status, 0);
  const res = JSON.parse(r.stdout.trim().split("\n")[0]);
  assert.equal(res.error.code, -32700);
});

test("resources/read returns the predicate, ceiling, map rules, and scene schema", () => {
  const requests = [INIT];
  RESOURCES.forEach((r, i) => requests.push({ jsonrpc: "2.0", id: 10 + i, method: "resources/read", params: { uri: r.uri } }));
  const out = runServer(requests);
  const byUri = {};
  for (const res of out.slice(1)) {
    const content = res.result.contents[0];
    byUri[content.uri] = JSON.parse(content.text);
  }
  assert.equal(byUri["hme://predicate"].version, "pred-v1");
  assert.equal(byUri["hme://predicate"].ssim_mean_min, 0.96);
  assert.equal(byUri["hme://predicate"].segment, "seg4");
  assert.equal(byUri["hme://ceiling"].clean.ssim, 0.9708);
  assert.ok(byUri["hme://rules/map"].registers.includes("Two registers only"));
  assert.ok(byUri["hme://schema/scene"].node_types.includes("map"));
  assert.ok(Array.isArray(byUri["hme://schema/scene"].top_level_required));
});

test("resources/read of an unknown URI is a -32602 error", () => {
  const [, res] = runServer([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "hme://nope" } },
  ]);
  assert.equal(res.error.code, -32602);
  assert.ok(res.error.message.includes("unknown resource"));
});

test("validateToolArgs catches a missing argument, a wrong type, and an unknown tool", () => {
  assert.equal(validateToolArgs("compare", { ref: "a.mp4" }), "missing required argument: ours");
  assert.equal(validateToolArgs("compare", { ref: "a.mp4", ours: "b.mp4" }), null);
  assert.equal(validateToolArgs("trace", { video: "v.mp4", start_s: "0", end_s: 8 }), "argument start_s must be a number");
  assert.equal(validateToolArgs("render", {}), "unknown tool: render");
  assert.equal(validateToolArgs("control", { video: "v.mp4", crf: 28.5 }), "argument crf must be a whole number");
});

test("buildSummary says the verdict and the headline numbers in plain words", () => {
  const report = {
    verdict: { status: "FAIL", failed_bar: "SSIM >= 0.96 (pred-v1)", detail: "Mean SSIM 0.7941 is below the 0.96 bar." },
    numbers: {
      ssim_mean: 0.7941, psnr_mean: 20.21, lpips_mean: 0.6312, frames: 192,
      cut: { frame: 186, second: 7.75, found: true },
      map_only: { ssim_mean: 0.7975, psnr_mean: 20.41 },
    },
    corrections: [],
    context: { thresholds: {}, control_ceiling: null, meaning: "x" },
    next: "hme diagnose",
    limits: [],
  };
  const s = buildSummary("compare", report);
  assert.ok(s.includes("Mean SSIM 0.7941 is below the 0.96 bar."), s);
  assert.ok(s.includes("Cut at frame 186 (7.75 s)."), s);
  assert.ok(s.includes("Map-only mean SSIM 0.7975"), s);
  assert.equal(buildSummary("trace", { cuts_s: [7.75], palette: [{ hex: "#143C34" }], frames: 192 }).includes("Cuts at 7.75 s."), true);
});

test("readResource throws a plain error for an unknown URI", () => {
  assert.throws(() => readResource("hme://nope"), /unknown resource: hme:\/\/nope/);
});

test("tools/call context returns the same JSON as the CLI, plus a summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "hme-mcp-test-"));
  try {
    const cliOut = join(dir, "cli-context.json");
    const cli = spawnSync(process.execPath, [HME, "context", "--out", cliOut], { encoding: "utf8" });
    // The last check failed, so the CLI exits 1. That is the report,
    // not a crash.
    assert.equal(cli.status, 1, cli.stderr);
    const cliReport = JSON.parse(readFileSync(cliOut, "utf8"));
    const [, res] = runServer([
      INIT,
      {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "context", arguments: {} },
      },
    ]);
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.equal(res.result.content[0].type, "text");
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(typeof payload.summary, "string");
    assert.ok(payload.summary.length > 0);
    assert.deepEqual(payload.report, cliReport);
    assert.deepEqual(res.result.structuredContent, payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools/call compare with missing files is a -32602 error, not a crash", () => {
  const [, res] = runServer([
    INIT,
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "compare", arguments: { ref: "no-such-ref.mp4", ours: "no-such-ours.mp4" } },
    },
  ]);
  assert.equal(res.error.code, -32602);
  assert.ok(res.error.message.includes("hme compare"), res.error.message);
});

test("tools/call of an unknown tool is a -32602 error", () => {
  const [, res] = runServer([
    INIT,
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "render", arguments: {} },
    },
  ]);
  assert.equal(res.error.code, -32602);
  assert.ok(res.error.message.includes("unknown tool"));
});

test("tools/call extract with a missing frame is a -32602 error", () => {
  const [, res] = runServer([
    INIT,
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "extract", arguments: { frame: "no-such-frame.png", colour: "#CC4726" } },
    },
  ]);
  assert.equal(res.error.code, -32602);
});
