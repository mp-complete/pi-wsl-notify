import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import test from "node:test";

// All effectful imports are mocked, including fs, models, terminal input and
// PowerShell. No Pi sessions, model calls, terminal escapes or desktop toasts.
const source = stripTypeScriptTypes(readFileSync(process.env.WSL_NOTIFY_SOURCE ?? new URL("../extensions/wsl-notify.ts", import.meta.url), "utf8"));
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const text = (text) => ({ type: "text", text });
const response = (value = "Updated the notifier; tests passed.", stopReason = "stop") => ({ content: [text(value)], stopReason });

async function harness(options = {}) {
  const handlers = new Map(), commands = new Map(), timers = new Map();
  const calls = [], notices = [], modelCalls = [], modelLookups = [];
  let now = 10000, timerId = 0, terminalInput, signal, config = options.config;
  let reads = 0;
  const context = createContext({
    Buffer, AbortController, Map, console,
    Date: class extends Date { static now() { return now; } },
    process: { platform: options.platform ?? "linux", stdout: { isTTY: options.tty ?? true }, env: options.env ?? {} },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const exports = {
    "node:child_process": { execFile: (file, args, opts, callback) => {
      calls.push({ file, args: Array.from(args), opts });
      if (options.holdToast) {
        opts.signal.addEventListener("abort", () => callback(new Error("aborted")), { once: true });
      } else callback(options.toastError ? new Error("payload-sensitive stderr") : null);
    } },
    "node:crypto": { createHash },
    "node:fs": { readFileSync: (path) => {
      reads++;
      assert.equal(path, "/profile/wsl-notify.json");
      if (config === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return typeof config === "string" ? config : JSON.stringify(config);
    } },
    "node:os": { homedir: () => "/home/test", release: () => options.release ?? "6.6-microsoft-standard-WSL2" },
    "node:path": { basename, join },
    "node:util": { stripVTControlCharacters },
    "@earendil-works/pi-coding-agent": { getAgentDir: () => "/profile" },
    "@earendil-works/pi-tui": { getKeybindings: () => ({ matches: (data, action) => {
      assert.equal(action, "app.interrupt");
      return data === (options.interruptKey ?? "\x1b");
    } }) },
  };
  const module = new SourceTextModule(source, { context });
  await module.link((name) => {
    assert.ok(exports[name], `unexpected import ${name}`);
    const values = exports[name];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  module.namespace.default({
    on: (name, fn) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); },
    registerCommand: (name, command) => commands.set(name, command),
  });
  assert.equal(reads, 0, "registration must not read config");
  assert.equal(calls.length + timers.size + modelCalls.length, 0, "registration must have no side effects");
  const model = { provider: options.provider ?? "github-copilot", id: "gpt-5.6-terra" };
  const ctx = {
    cwd: options.cwd ?? "/home/test/src/project", mode: options.mode ?? "tui", hasUI: true,
    model: options.noActiveModel ? undefined : { provider: model.provider, id: "main-model" },
    sessionManager: { getSessionId: () => "session-one" },
    hasPendingMessages: () => Boolean(options.queued),
    get signal() { return signal?.signal; },
    ui: {
      notify: (...args) => notices.push(args),
      onTerminalInput: (fn) => { terminalInput = fn; return () => { terminalInput = undefined; }; },
    },
    modelRegistry: {
      find: (provider, id) => {
        modelLookups.push({ provider, id });
        if (options.modelLookupThrow) throw new Error("model registry unavailable");
        return options.noModel ? undefined : { ...model, id };
      },
      hasConfiguredAuth: () => !options.noAuth,
      streamSimple: (model, request, opts) => {
        modelCalls.push({ model, request, opts });
        if (options.modelThrow) throw new Error("sensitive auth error");
        return { result: () => options.result ? options.result() : Promise.resolve(options.response ?? response()) };
      },
    },
  };
  const emit = async (name, event = {}) => { await handlers.get(name)?.({ type: name, ...event }, ctx); };
  const start = async (prompt = "Fix notifications") => {
    await emit("before_agent_start", { prompt });
    signal = new AbortController();
    await emit("agent_start");
  };
  const message = async (value = "Implemented notifications.", stopReason = "stop") => {
    await emit("message_end", { message: { role: "assistant", stopReason, content: [text(value)] } });
  };
  const boundary = (outcome = "completed") => {
    signal = undefined; // Agent-core disposes its active signal before this session boundary.
    return emit("agent_before_settle", { outcome });
  };
  const settle = async () => { signal = undefined; await emit("agent_settled"); await tick(); };
  const finish = async (value, outcome = "completed") => {
    await message(value, outcome === "error" ? "error" : outcome === "aborted" ? "aborted" : "stop");
    await emit("agent_end");
    await boundary(outcome);
    await settle();
  };
  await emit("session_start");
  return {
    calls, notices, modelCalls, modelLookups, ctx, emit, start, message, boundary, settle, finish,
    abort: () => signal.abort(), key: (key) => terminalInput?.(key),
    config: (value) => { config = value; },
    command: async (args) => { await commands.get("wsl-notify").handler(args, ctx); await tick(); },
    advance: async (ms) => {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await tick();
    },
    hasInput: () => Boolean(terminalInput), timerCount: () => timers.size,
    continue: async () => { signal = new AbortController(); await emit("agent_start"); },
  };
}

function toast(h, index = 0) {
  const call = h.calls[index];
  assert.equal(call.file, "powershell.exe");
  assert.deepEqual(call.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
  const script = Buffer.from(call.args[6], "base64").toString("utf16le");
  const payload = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.ok(payload, "only base64 data should be interpolated into script");
  assert.equal(call.opts.timeout, 5000);
  assert.equal(call.opts.windowsHide, true);
  assert.ok(!call.opts.shell);
  return { script, xml: Buffer.from(payload, "base64").toString("utf8") };
}

test("WSL without WT_SESSION: completion yields one summarized, silent toast with directory and duration", async () => {
  const h = await harness();
  await h.start();
  await h.advance(134000);
  await h.finish();
  assert.equal(h.calls.length, 1);
  assert.equal(h.modelCalls.length, 1);
  assert.deepEqual(h.modelLookups, [{ provider: "github-copilot", id: "gpt-5.6-terra" }]);
  const { xml, script } = toast(h);
  assert.match(xml, /Pi · project · Ready/);
  assert.match(xml, /Updated the notifier; tests passed\./);
  assert.match(xml, /~\/src\/project · 2m 14s/);
  assert.match(xml, /<audio silent="true"\/>/);
  assert.match(script, /Group = 'pi-wsl-notify'/);
  assert.match(script, /Tag = '[a-f0-9]{16}'/);
  await h.settle();
  assert.equal(h.calls.length, 1, "duplicate settlement must not notify");
  assert.equal(h.timerCount(), 0);
});

test("abort signal suppresses both summary and toast even if the last message looked successful", async () => {
  const h = await harness();
  await h.start(); await h.message(); h.abort(); await h.boundary(); await h.settle();
  assert.equal(h.modelCalls.length + h.calls.length, 0);
});

test("aborted message and aborted boundary each suppress notifications", async () => {
  for (const via of ["message", "boundary"]) {
    const h = await harness(); await h.start();
    await h.message("stopped", via === "message" ? "aborted" : "stop");
    await h.boundary(via === "boundary" ? "aborted" : "completed"); await h.settle();
    assert.equal(h.modelCalls.length + h.calls.length, 0);
  }
});

test("cancel during retry/compaction with no pre-settle boundary stays silent", async () => {
  const h = await harness(); await h.start(); await h.message("", "error");
  await h.emit("agent_end"); await h.settle();
  assert.equal(h.modelCalls.length + h.calls.length, 0);
});

test("configured interrupt key suppresses late cancellation after the boundary", async () => {
  const h = await harness({ interruptKey: "custom-interrupt" });
  await h.start(); await h.message(); await h.boundary(); h.key("custom-interrupt"); await h.settle();
  assert.equal(h.modelCalls.length + h.calls.length, 0);
});

test("Escape inside an extension dialog isn't treated as cancelling the whole run", async () => {
  const h = await harness(); await h.start(); await h.emit("ui_prompt_start"); h.key("\x1b");
  await h.emit("ui_prompt_end"); await h.finish(); assert.equal(h.calls.length, 1);
});

test("Escape during active streaming isn't a cancellation unless the run signal aborts", async () => {
  const h = await harness(); await h.start(); h.key("\x1b");
  await h.finish(); assert.equal(h.calls.length, 1);
});

test("agent_end and actionable boundary do not notify; retries/continuations settle once", async () => {
  const h = await harness(); await h.start(); await h.message("", "error"); await h.emit("agent_end");
  assert.equal(h.calls.length + h.modelCalls.length, 0);
  await h.continue(); await h.message("first result"); await h.boundary();
  assert.equal(h.calls.length + h.modelCalls.length, 0);
  await h.continue(); await h.finish("final result");
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.modelCalls[0].request.messages[0].content[0].text).finalReply, "final result");
});

test("terminal failure gets an Error toast, not a successful-completion claim", async () => {
  const h = await harness({ noModel: true }); await h.start(); await h.finish("", "error");
  const { xml } = toast(h);
  assert.match(xml, /Pi · project · Error/);
  assert.match(xml, /Run failed\. Check Pi for details\./);
});

test("new runs don't inherit cancellation", async () => {
  const h = await harness(); await h.start(); h.abort(); await h.finish();
  await h.start(); await h.finish(); assert.equal(h.calls.length, 1);
});

test("non-WSL, non-TTY and non-TUI sessions never call models or transports", async () => {
  for (const options of [{ platform: "darwin" }, { release: "Linux" }, { tty: false }, { mode: "print" }, { mode: "json" }, { mode: "rpc" }]) {
    const h = await harness(options); await h.start(); await h.finish();
    assert.equal(h.calls.length + h.modelCalls.length, 0, JSON.stringify(options));
  }
});

test("WSL markers work independently from kernel spelling and Windows Terminal", async () => {
  for (const env of [{ WSL_DISTRO_NAME: "NixOS" }, { WSL_INTEROP: "/run/WSL/1_interop" }]) {
    const h = await harness({ release: "Linux", env }); await h.start(); await h.finish();
    assert.equal(h.calls.length, 1);
  }
});

test("queued work, configured disable, event filters and minimum durations suppress early", async () => {
  for (const options of [{ queued: true }, { config: { enabled: false } }, { config: { notifyOn: ["error"] } }, { config: { minDurationMs: 30000 } }]) {
    const h = await harness(options); await h.start(); await h.finish();
    assert.equal(h.calls.length + h.modelCalls.length, 0);
  }
  const h = await harness({ config: { minDurationMs: 30000 } });
  await h.start(); await h.advance(30000); await h.finish(); assert.equal(h.calls.length, 1);
});

test("utility receives bounded latest text/tool outcomes, never thinking, images, arguments or history", async () => {
  const h = await harness();
  await h.start("REQUEST " + "x".repeat(20000));
  await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "HIDDEN_REASONING" }, { type: "image", data: "IMAGE_BYTES" },
    { type: "toolCall", name: "bash", arguments: { command: "SECRET_ARGUMENTS" } },
  ] } });
  for (let i = 0; i < 20; i++) await h.emit("tool_execution_end", {
    toolName: "bash", isError: i === 19, result: { content: [text(`tool-${i}: ${"y".repeat(2000)}`)], details: { hidden: "RESULT_DETAILS" } },
  });
  await h.finish("FINAL " + "z".repeat(20000));
  const call = h.modelCalls[0], body = call.request.messages[0].content[0].text, data = JSON.parse(body);
  assert.equal(call.model.provider, "github-copilot");
  assert.equal(call.request.messages.length, 1);
  assert.equal(call.request.tools.length, 0);
  assert.ok(body.length < 11000);
  assert.ok(data.request.length <= 1200 && data.finalReply.length <= 4000);
  assert.equal(data.toolCount, 20); assert.equal(data.toolErrors, 1);
  assert.equal(data.recentToolOutcomes.length, 6);
  assert.ok(data.recentToolOutcomes.every((tool) => tool.excerpt.length <= 700));
  assert.doesNotMatch(body, /HIDDEN_REASONING|IMAGE_BYTES|SECRET_ARGUMENTS|RESULT_DETAILS|\/home\/test/);
  assert.match(toast(h).xml, /1 tool error during run/);
  assert.equal(call.opts.maxRetries, 0); assert.equal(call.opts.reasoning, undefined);
  assert.equal(call.opts.cacheRetention, "none"); assert.equal(call.opts.maxTokens, 256);
});

test("latest user message (steering) replaces the initial request in summary input", async () => {
  const h = await harness(); await h.start("old request");
  await h.emit("message_end", { message: { role: "user", content: [text("new request")] } });
  await h.finish(); assert.equal(JSON.parse(h.modelCalls[0].request.messages[0].content[0].text).request, "new request");
});

test("common secret shapes are redacted from utility input and output", async () => {
  const secrets = "Bearer abc.def.ghi password=secret123 api_key=secret456 sk-abcdefghijklmnop https://user:password@example.org";
  const h = await harness({ response: response(secrets) }); await h.start(secrets); await h.finish(secrets);
  const body = h.modelCalls[0].request.messages[0].content[0].text;
  assert.doesNotMatch(body + toast(h).xml, /abc\.def\.ghi|secret123|secret456|sk-abcdefghijklmnop|user:password/);
  assert.match(body, /REDACTED/);
});

test("summary cap is 140 Unicode code points; controls cannot become toast markup or PowerShell", async () => {
  const attack = "\x1b[31m$([evil]); </text><script> ' \" & \u0000\u202E " + "😀".repeat(200);
  const h = await harness({ cwd: "/home/test/a';&<>$project", response: response(attack) });
  await h.start(); await h.finish();
  const { xml, script } = toast(h);
  assert.doesNotMatch(xml, /\x1b|\u0000|\u202E|<script>/);
  assert.match(xml, /&lt;script&gt;/);
  assert.match(xml, /&apos;/);
  assert.doesNotMatch(script, /evil|project|<script>/);
  const escapedBody = xml.match(/<text>(.*?)<\/text><text>(.*?)<\/text>/)[2];
  const body = escapedBody.replace(/&(?:amp|lt|gt|quot|apos);/g, "x");
  assert.equal(Array.from(body).length, 140);
});

test("missing model/auth, throwing/failed/empty results and summary-off all use a local fallback", async () => {
  for (const options of [{ noModel: true }, { noAuth: true }, { noActiveModel: true }, { modelThrow: true }, { modelLookupThrow: true },
    { response: response("", "error") }, { response: response("", "aborted") }, { response: response("") },
    { result: () => Promise.reject(new Error("sensitive model failure")) }, { config: { summarize: false } }]) {
    const h = await harness(options); await h.start(); await h.finish();
    assert.match(toast(h).xml, /Ready for input\. Check Pi for the result\./);
    assert.match(toast(h).xml, /No AI summary/);
    assert.equal(h.notices.length, 0);
  }
});

test("exact configurable model ID stays on active provider, even if it contains slashes", async () => {
  const h = await harness({ provider: "openrouter", config: { model: "openai/gpt-5.6-terra" } });
  await h.start(); await h.finish();
  assert.deepEqual(h.modelLookups, [{ provider: "openrouter", id: "openai/gpt-5.6-terra" }]);
});

test("settlement doesn't wait for a hung model; deadline aborts it and emits one fallback", async () => {
  let resolve;
  const h = await harness({ result: () => new Promise((r) => { resolve = r; }), config: { summaryTimeoutMs: 100 } });
  await h.start(); await h.finish();
  assert.equal(h.calls.length, 0, "finish returned while model is pending");
  await h.advance(100);
  assert.equal(h.modelCalls[0].opts.signal.aborted, true);
  assert.equal(h.calls.length, 1);
  resolve(response("late result")); await tick(); assert.equal(h.calls.length, 1);
  assert.equal(h.timerCount(), 0);
});

test("new input/run, navigation, shutdown, mute, reload and interruption discard in-flight summaries", async () => {
  for (const action of ["input", "start", "session_before_switch", "session_tree", "session_shutdown", "mute", "reload", "interrupt", "model_select", "user_bash"]) {
    let resolve;
    const h = await harness({ result: () => new Promise((r) => { resolve = r; }) });
    await h.start(); await h.finish();
    if (action === "start") await h.start("new task");
    else if (action === "mute" || action === "reload") await h.command(action);
    else if (action === "interrupt") h.key("\x1b");
    else await h.emit(action);
    resolve(response("obsolete")); await tick();
    assert.equal(h.calls.length, 0, action);
    assert.equal(h.modelCalls[0].opts.signal.aborted, true, action);
    assert.equal(h.timerCount(), 0, action);
  }
});

test("stale job completion can't clear or notify over a newer pending job", async () => {
  const resolvers = [];
  const h = await harness({ result: () => new Promise((resolve) => resolvers.push(resolve)) });
  await h.start(); await h.finish(); await h.start("new task"); await h.finish();
  resolvers[0](response("old result")); await tick(); assert.equal(h.calls.length, 0);
  resolvers[1](response("new result")); await tick(); assert.equal(h.calls.length, 1);
  assert.match(toast(h).xml, /new result/);
});

test("mute/unmute and reload work without modifying files or spawning tests", async () => {
  const h = await harness(); await h.command("mute"); await h.start(); await h.finish();
  assert.equal(h.calls.length + h.modelCalls.length, 0);
  await h.command("unmute"); await h.start(); await h.finish(); assert.equal(h.calls.length, 1);
  h.config({ enabled: false }); await h.command("reload"); await h.start(); await h.finish();
  assert.equal(h.calls.length, 1);
  await h.command("status"); assert.match(h.notices.at(-1)[0], /notifications: off/);
  await h.command("invalid"); assert.match(h.notices.at(-1)[0], /Usage:/);
});

test("malformed/unknown/invalid config fails closed and can recover via reload", async () => {
  for (const config of ["{", "null", "[]", '{"toString":true}', '{"__proto__":{}}', { enabled: "yes" }, { provider: "unapproved-provider" },
    { notifyOn: ["aborted"] }, { summaryTimeoutMs: -1 }, { minDurationMs: 1.2 }, { model: "" },
    { summarize: false, typo: true }, " ".repeat(16385)]) {
    const h = await harness({ config }); await h.start(); await h.finish();
    assert.equal(h.calls.length + h.modelCalls.length, 0);
    assert.match(h.notices[0][0], /invalid wsl-notify.json/);
    h.config({ summarize: false }); await h.command("reload"); await h.start(); await h.finish();
    assert.equal(h.calls.length, 1);
  }
});

test("transport failure is caught without leaking model content or PowerShell stderr", async () => {
  const h = await harness({ toastError: true }); await h.start(); await h.finish();
  assert.equal(h.notices.length, 1); assert.match(h.notices[0][0], /delivery failed/);
  assert.doesNotMatch(h.notices[0][0], /payload-sensitive/);
});

test("a pending PowerShell process receives cancellation on new input", async () => {
  const h = await harness({ holdToast: true }); await h.start(); await h.finish();
  assert.equal(h.calls.length, 1);
  await h.emit("input"); await tick(); assert.equal(h.calls[0].opts.signal.aborted, true);
  assert.equal(h.notices.length, 0);
});

test("shutdown removes terminal listener; sound can be enabled explicitly", async () => {
  const h = await harness({ config: { sound: true } }); await h.start(); await h.finish();
  assert.doesNotMatch(toast(h).xml, /audio silent/);
  assert.ok(h.hasInput()); await h.emit("session_shutdown"); assert.ok(!h.hasInput());
});
