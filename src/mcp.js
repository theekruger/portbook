// portbook MCP server — exposes the registry + ecosystem as Model Context Protocol tools so MCP
// harnesses (Claude Code, Codex, Cursor, Windsurf, Hermes) can drive portbook directly.
//
// Transport: JSON-RPC 2.0 over newline-delimited stdio (one JSON object per line, in and out). This
// is the simplest MCP transport and needs no framing headers. NOTHING but JSON-RPC may touch the
// output stream — diagnostics go to process.stderr — or the harness's parser will choke.
//
// Zero dependencies: just the registry/environment functions and node streams.
import { pathToFileURL } from "node:url";
import { reserve, release, list, check, gc, scan, annotate } from "./registry.js";
import { ecosystem } from "./environments.js";

const PROTOCOL_VERSION = "2024-11-05"; // fallback when the client doesn't announce its own

// --- tool definitions ----------------------------------------------------------------------------
// Each tool maps 1:1 onto a registry/environment call. `inputSchema` is a JSON Schema object so the
// harness can validate/auto-complete arguments. `run(args)` returns the raw value to serialize.
const port = { type: "integer", minimum: 1, maximum: 65535 };
const TOOLS = [
  {
    name: "reserve",
    description: "Reserve a port (or a free one from a range) for a project, recording who owns it and why. Use --adopt for a service you already run on.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project the reservation belongs to (required)." },
        port: { ...port, description: "Specific port to reserve; omit to auto-pick a free one from the range." },
        count: { type: "integer", minimum: 1, description: "How many ports to reserve when auto-picking (default 1)." },
        purpose: { type: "string", description: "Human note: what this port is for." },
        owner: { type: "string", description: "Who/what holds it (e.g. an agent name)." },
        pid: { type: "integer", description: "Owning process id — lets gc reclaim the hold when the process dies." },
        ttlSec: { type: "integer", description: "Seconds until the reservation auto-expires." },
        rangeStart: { type: "integer", description: "Low end of the auto-pick range (default 4000)." },
        rangeEnd: { type: "integer", description: "High end of the auto-pick range (default 4999)." },
        adopt: { type: "boolean", description: "Register a port you're ALREADY listening on (skips the OS-free check)." },
      },
      required: ["project"],
    },
    run: (a) => reserve(a),
  },
  {
    name: "release",
    description: "Release reservation(s) by project, port, or id. At least one selector is required.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Release every reservation for this project." },
        port: { ...port, description: "Release the reservation on this port." },
        id: { type: "string", description: "Release the single reservation with this id." },
      },
    },
    run: (a) => release(a),
  },
  {
    name: "list",
    description: "List reservations (optionally for one project), annotated with live OS truth: whether each port is actually bound and whether the hold is stale.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Only list reservations for this project." } },
    },
    run: (a) => annotate(list(a)),
  },
  {
    name: "check",
    description: "Check a single port: its reservation (if any) and whether the OS reports it free right now.",
    inputSchema: {
      type: "object",
      properties: { port: { ...port, description: "Port to check (required)." } },
      required: ["port"],
    },
    run: (a) => check(a.port),
  },
  {
    name: "scan",
    description: "Cross-reference what's actually listening on this machine against the registry: managed, unmanaged, and ghost (reserved-but-not-listening) ports.",
    inputSchema: { type: "object", properties: {} },
    run: () => scan(),
  },
  {
    name: "ecosystem",
    description: "The full picture for this machine: host listeners labeled by process/container/reservation, containers (published + internal ports), WSL distros, and ghost reservations.",
    inputSchema: { type: "object", properties: {} },
    run: () => ecosystem(),
  },
  {
    name: "gc",
    description: "Reclaim stale reservations (dead owning PID or expired TTL). Returns the removed entries.",
    inputSchema: { type: "object", properties: {} },
    run: () => gc(),
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --- JSON-RPC handling ----------------------------------------------------------------------------
// Dispatch one parsed request. Returns the response object to send, or null for notifications (any
// message without an id, e.g. "notifications/initialized") which MUST get no reply.
async function handle(msg) {
  const isNotification = msg == null || msg.id === undefined || msg.id === null;
  const { id, method, params } = msg || {};

  // Notifications never get a response — including unknown "notifications/*".
  if (isNotification) return null;

  try {
    if (method === "initialize") {
      return ok(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "portbook", version: "0.2.0" },
      });
    }
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") {
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === "tools/call") {
      const tool = TOOL_BY_NAME.get(params?.name);
      if (!tool) return ok(id, { content: [{ type: "text", text: `unknown tool: ${params?.name}` }], isError: true });
      try {
        const value = await tool.run(params.arguments || {});
        return ok(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
      } catch (e) {
        // Tool-level failures are reported as a successful result with isError — not a JSON-RPC error.
        return ok(id, { content: [{ type: "text", text: e?.message || String(e) }], isError: true });
      }
    }
    // A request (has an id) for a method we don't implement.
    return err(id, -32601, "method not found");
  } catch (e) {
    return err(id, -32603, e?.message || String(e)); // internal error — should be rare
  }
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// Run the server over the given streams (defaults to real stdio; injectable for tests). Resolves when
// the input stream ends. Reads newline-delimited JSON, buffering partial lines across chunks; writes
// each response as one line of JSON. Malformed lines are skipped (logged to stderr), never crash.
export function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    let buf = "";
    let chain = Promise.resolve(); // serializes handlers so responses are emitted in request order
    const write = (obj) => { if (obj) output.write(JSON.stringify(obj) + "\n"); };

    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); }
        catch { process.stderr.write("portbook mcp: skipping malformed line\n"); continue; }
        chain = chain.then(() => handle(req)).then(write).catch((e) => process.stderr.write(`portbook mcp: ${e?.message || e}\n`));
      }
    });
    input.on("end", resolve);
    input.on("close", resolve);
  });
}

// Allow `node src/mcp.js` to start the server directly (in addition to being driven by the CLI's
// `portbook mcp` command). Guarded so a plain `import` of this module never auto-runs — only direct
// execution, where argv[1] is this file, does. Errors go to stderr to keep stdout pure JSON-RPC.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch((e) => { process.stderr.write(`portbook mcp: ${e?.message || e}\n`); process.exit(1); });
}
