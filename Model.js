.pragma library

// Everything the plugin decides lives here as plain functions: reading the
// output of `fleet status --all --json`, classifying each host, summarising
// the fleet into one icon state, and building the argument lists of the two
// kinds of process the plugin starts. The QML files only schedule and draw.
//
// No QML types and no Node-only APIs, so tests/test_model.js runs this very
// file under Node.

var GREEN = "green";
var AMBER = "amber";
var RED = "red";
var DIM = "dim";
// A host fleet cannot ask (no ssh destination): it counts for nothing.
var NEUTRAL = "neutral";

var MAX_STATUS_BYTES = 1024 * 1024;
var MAX_HOSTS = 64;
var MAX_TEXT = 80;
var RESULTS = ["ok", "unreachable", "timer", "error"];

var DEFAULTS = {
  checkIntervalMinutes: 15,
  notSeenHours: 2,
  fleetCommand: "fleet",
  terminalCommand: "omarchy-launch-or-focus-tui",
  iconAlwaysUnlit: false
};

// ---------------------------------------------------------------- settings

function clampInt(value, fallback, minimum, maximum) {
  var n = parseInt(String(value), 10);
  if (!isFinite(n)) n = fallback;
  return Math.max(minimum, Math.min(maximum, n));
}

function asBool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return fallback;
  var text = String(value).toLowerCase();
  return text === "true" || text === "yes" || text === "on" || text === "1";
}

// Both commands end up inside the `eval` that omarchy-launch-or-focus runs,
// so a token is a plain word or path, never anything a shell would act on.
var SAFE_TOKEN = /^[A-Za-z0-9._\/+@:=-]+$/;

// A command setting as a list of words. A setting with anything unsafe in it
// falls back to the default, so a typo can not turn into a shell command.
function splitCommand(text, fallback) {
  var tokens = String(text === undefined || text === null ? "" : text).trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") return fallback.slice();
  for (var i = 0; i < tokens.length; i++) {
    if (!SAFE_TOKEN.test(tokens[i]) || (i === 0 && tokens[i].charAt(0) === "-")) return fallback.slice();
  }
  return tokens;
}

// fleet's subcommands. The fleet command setting names the program, never one of these, so it can not turn
// the status check into a command that changes something (`fleet push status --all --json`).
var FLEET_VERBS = ["status", "doctor", "context", "diff", "bridge", "apply", "push", "adopt", "secrets",
  "skills", "update", "new", "init", "demo", "agent", "help"];

function fleetCommand(text) {
  var fallback = [DEFAULTS.fleetCommand];
  var tokens = splitCommand(text, fallback);
  for (var i = 0; i < tokens.length; i++) {
    if (FLEET_VERBS.indexOf(tokens[i]) !== -1) return fallback;
  }
  return tokens;
}

function resolveSettings(raw) {
  var s = raw || {};
  return {
    checkIntervalMs: clampInt(s.checkIntervalMinutes, DEFAULTS.checkIntervalMinutes, 1, 1440) * 60 * 1000,
    notSeenMs: clampInt(s.notSeenHours, DEFAULTS.notSeenHours, 1, 720) * 3600 * 1000,
    fleet: fleetCommand(s.fleetCommand),
    terminal: splitCommand(s.terminalCommand, [DEFAULTS.terminalCommand]),
    unlit: asBool(s.iconAlwaysUnlit, DEFAULTS.iconAlwaysUnlit)
  };
}

// ---------------------------------------------------------------- commands

var HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function isHostName(name) {
  return typeof name === "string" && HOST_NAME.test(name);
}

// The only fleet command the plugin runs. It is a shell wrapper just to tell
// "fleet is not installed" (127) from "fleet failed", and the command words
// reach it as arguments, never as shell text.
var STATUS_SCRIPT = 'command -v -- "$1" >/dev/null 2>&1 || exit 127; exec "$@"';
var NOT_INSTALLED = 127;

function statusCommand(fleetTokens) {
  return ["sh", "-c", STATUS_SCRIPT, "sh"].concat(fleetTokens, ["status", "--all", "--json"]);
}

// `fleet bridge`, through the terminal launcher. The launcher names the
// window after the first word of what it starts, not after its arguments, so
// every bridge shares one window class: an open bridge is focused whatever
// screen or host was asked for, and a second one is never started.
// target: {} for Home, {view: "conflicts"}, or {host: "name"}.
function bridgeCommand(settings, target) {
  var args = settings.terminal.concat(settings.fleet, ["bridge"]);
  var t = target || {};
  if (t.host !== undefined) {
    if (!isHostName(t.host)) return null;
    args.push("--host", t.host);
  } else if (t.view !== undefined) {
    if (t.view !== "conflicts") return null;
    args.push("--view", t.view);
  }
  return args;
}

// ----------------------------------------------------------------- parsing

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printable(value, max) {
  if (typeof value !== "string") return "";
  return value.slice(0, max || MAX_TEXT).replace(/[^\x20-\x7e]/g, "?");
}

function count(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0 ? value : null;
}

function shortCommit(value) {
  var text = printable(value, 64);
  return /^[0-9a-f]{7,64}$/.test(text) ? text.slice(0, 7) : "";
}

// `conflicts` is the count. `conflictList` is the host's first few conflicts as
// {kind, path}, sent by a newer fleet; an older one sends no list and the row
// shows the count alone. Only kind and path of the first entry are kept, never
// the detail text.
function conflictFields(conflicts, list) {
  var total = count(conflicts);
  var first = Array.isArray(list) && total !== 0 && isObject(list[0]) ? printable(list[0].kind, 16) + " " + printable(list[0].path, 60) : "";
  return { conflicts: total, firstConflict: first.trim() };
}

// The one place a host is shaped: used for fleet's own output and again for
// what is read back from the plugin's saved state.
function normalizeHost(raw) {
  if (!isObject(raw)) return null;
  var name = printable(raw.name, 64);
  if (name === "") return null;
  var firstConflict = printable(raw.firstConflict, MAX_TEXT);
  return {
    name: name,
    result: RESULTS.indexOf(raw.result) >= 0 ? raw.result : "error",
    detail: printable(raw.detail, MAX_TEXT),
    timer: printable(raw.timer, 24),
    conflicts: count(raw.conflicts),
    firstConflict: firstConflict,
    pending: count(raw.pending),
    appliedAt: printable(raw.appliedAt, 32),
    appliedAgeSeconds: count(raw.appliedAgeSeconds)
  };
}

function normalizeModel(raw) {
  if (!isObject(raw) || !Array.isArray(raw.hosts)) return null;
  var hosts = [];
  for (var i = 0; i < raw.hosts.length && hosts.length < MAX_HOSTS; i++) {
    var host = normalizeHost(raw.hosts[i]);
    if (host) hosts.push(host);
  }
  return { host: printable(raw.host, 64), config: shortCommit(raw.config), hosts: hosts };
}

function hostFromDocument(entry) {
  if (!isObject(entry)) return null;
  var status = isObject(entry.status) ? entry.status : {};
  var applied = isObject(status.applied) ? status.applied : {};
  var fields = conflictFields(status.conflicts, status.conflictList);
  return {
    name: entry.host,
    result: entry.result,
    detail: entry.detail,
    timer: status.timer,
    conflicts: fields.conflicts,
    firstConflict: fields.firstConflict,
    pending: status.pending,
    appliedAt: applied.at,
    appliedAgeSeconds: applied.ageSeconds,
    config: applied.config
  };
}

// Only the fields the panel shows are read out of fleet's document; the rest
// (tool versions, clone state) is dropped here and never stored.
function modelFromDocument(doc) {
  if (!isObject(doc) || !Array.isArray(doc.hosts)) return null;
  var local = printable(doc.host, 64);
  var config = isObject(doc.applied) ? doc.applied.config : undefined;
  var hosts = [];
  for (var i = 0; i < doc.hosts.length; i++) {
    var entry = hostFromDocument(doc.hosts[i]);
    if (!entry) continue;
    if (config === undefined && entry.name === local) config = entry.config;
    hosts.push(entry);
  }
  return normalizeModel({ host: local, config: config, hosts: hosts });
}

// What one run of the status command came to.
//   missing  fleet is not on the path
//   nohost   fleet answered but this machine has no host name or no hosts
//   failed   no usable document (the message says why, without fleet's text)
//   ok       a model
// A non-zero exit still carries a document when a host was unreachable.
function interpretRun(exitCode, stdout) {
  if (exitCode === NOT_INSTALLED) return { kind: "missing" };
  var text = String(stdout || "");
  if (text.length > MAX_STATUS_BYTES) return { kind: "failed", message: "fleet status printed too much" };
  var doc = null;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    doc = null;
  }
  var model = modelFromDocument(doc);
  if (model === null) return { kind: "failed", message: "fleet status gave no document (exit " + exitCode + ")" };
  if (model.host === "" || model.hosts.length === 0) return { kind: "nohost" };
  return { kind: "ok", model: model };
}

// ------------------------------------------------------------------- state

function emptyState() {
  return { model: null, checkedAtMs: 0, lastSeen: {}, error: "", unavailable: "" };
}

// The moment each host last answered, so a host that stops answering is
// told apart from one that was just checked.
function updateLastSeen(previous, hosts, nowMs) {
  var next = {};
  for (var i = 0; i < hosts.length; i++) {
    var name = hosts[i].name;
    if (hosts[i].result === "ok") next[name] = nowMs;
    else if (previous && typeof previous[name] === "number") next[name] = previous[name];
  }
  return next;
}

function nextState(previous, run, nowMs) {
  var prev = previous || emptyState();
  if (run.kind === "ok") {
    return {
      model: run.model,
      checkedAtMs: nowMs,
      lastSeen: updateLastSeen(prev.lastSeen, run.model.hosts, nowMs),
      error: "",
      unavailable: ""
    };
  }
  if (run.kind === "failed") {
    return { model: prev.model, checkedAtMs: prev.checkedAtMs, lastSeen: prev.lastSeen, error: run.message, unavailable: "" };
  }
  // Nothing of fleet's to show: forget the last result too, so the next
  // start does not show a host list for a fleet that is gone.
  return { model: null, checkedAtMs: 0, lastSeen: {}, error: "", unavailable: run.kind };
}

// The widget shows once there is something to say: a result, or a failed
// check. Never while fleet is missing or has no host, and not before the
// first check has settled on a machine with nothing saved.
function isVisible(state) {
  return state.unavailable === "" && (state.model !== null || state.error !== "");
}

function serializeState(state) {
  return JSON.stringify({ version: 1, checkedAtMs: state.checkedAtMs, model: state.model, lastSeen: state.lastSeen }) + "\n";
}

function restoreState(text) {
  var state = emptyState();
  var doc = null;
  try {
    doc = JSON.parse(String(text || ""));
  } catch (e) {
    return state;
  }
  if (!isObject(doc) || doc.version !== 1) return state;
  var model = normalizeModel(doc.model);
  if (model === null) return state;
  var checked = typeof doc.checkedAtMs === "number" && isFinite(doc.checkedAtMs) ? doc.checkedAtMs : 0;
  var seen = {};
  if (isObject(doc.lastSeen)) {
    for (var i = 0; i < model.hosts.length; i++) {
      var value = doc.lastSeen[model.hosts[i].name];
      if (typeof value === "number" && isFinite(value)) seen[model.hosts[i].name] = value;
    }
  }
  state.model = model;
  state.checkedAtMs = checked;
  state.lastSeen = seen;
  return state;
}

// When the next check is due: at the interval after the last one, but never
// sooner than a few seconds after start, so the shell has settled.
function nextCheckDelayMs(checkedAtMs, nowMs, intervalMs) {
  var floor = 5000;
  if (!checkedAtMs) return floor;
  return Math.max(floor, Math.min(intervalMs, checkedAtMs + intervalMs - nowMs));
}

// ---------------------------------------------------------- classification

function formatAge(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return "";
  var s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 48 * 3600) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// One host. seenMs is when it last answered; a host not asked at all (timer)
// has no say. Amber reasons are listed in the order they are worth fixing.
function classifyHost(host, nowMs, seenMs, notSeenMs) {
  if (host.result === "unreachable") return { level: RED, label: "unreachable" };
  if (host.result === "error") return { level: RED, label: "error" };
  if (host.result === "timer") return { level: NEUTRAL, label: "not queried" };
  var reasons = [];
  if (host.conflicts !== null && host.conflicts > 0) reasons.push(plural(host.conflicts, "conflict"));
  if (host.timer !== "active") reasons.push("timer " + (host.timer === "" ? "unknown" : host.timer));
  if (typeof seenMs === "number" && nowMs - seenMs > notSeenMs) reasons.push("not seen " + formatAge((nowMs - seenMs) / 1000).replace(" ago", ""));
  if (reasons.length > 0) return { level: AMBER, label: reasons[0], reasons: reasons };
  return { level: GREEN, label: "ok" };
}

// The second half of a row's detail line: the timer for a host that
// answered, and for one that did not, what is known about it.
function timerText(host, seenMs, nowMs) {
  if (host.result === "ok") return "timer " + (host.timer === "" ? "unknown" : host.timer);
  if (host.result === "timer") return "applies on its own schedule";
  var seen = typeof seenMs === "number" ? "last seen " + formatAge((nowMs - seenMs) / 1000) : "never seen";
  return host.result === "error" && host.detail !== "" ? seen + ", " + host.detail : seen;
}

// The whole fleet for the icon and the panel. level is the worst host (dim
// with nothing known); count is the hosts that are not green.
function summarize(state, nowMs, notSeenMs) {
  if (state.model === null) return { level: DIM, count: 0, rows: [], total: 0 };
  var rows = [];
  var red = 0;
  var amber = 0;
  for (var i = 0; i < state.model.hosts.length; i++) {
    var host = state.model.hosts[i];
    var seen = state.lastSeen[host.name];
    var verdict = classifyHost(host, nowMs, seen, notSeenMs);
    var age = host.appliedAgeSeconds === null ? null : host.appliedAgeSeconds + Math.max(0, (nowMs - state.checkedAtMs) / 1000);
    rows.push({
      name: host.name,
      local: host.name === state.model.host,
      level: verdict.level,
      label: verdict.label,
      conflicts: host.conflicts,
      firstConflict: host.firstConflict,
      applied: host.result !== "ok" ? "" : host.appliedAt === "" ? "never applied" : "applied " + formatAge(age),
      timer: timerText(host, seen, nowMs),
      seen: typeof seen === "number" ? formatAge((nowMs - seen) / 1000) : "",
      openable: isHostName(host.name)
    });
    if (verdict.level === RED) red++;
    if (verdict.level === AMBER) amber++;
  }
  var level = red > 0 ? RED : amber > 0 ? AMBER : rows.length > 0 ? GREEN : DIM;
  return { level: level, count: red + amber, rows: rows, total: rows.length };
}

// The words for the tooltip and the panel hero.
function headline(summary, error) {
  if (summary.level === DIM) return error === "" ? "No fleet data yet" : "Fleet check failed";
  if (summary.count === 0) return "All " + plural(summary.total, "host") + " ok";
  return summary.count + " of " + plural(summary.total, "host") + " need attention";
}
