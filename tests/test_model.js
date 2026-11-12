#!/usr/bin/env node
// Tests for Model.js, run against the real file (not a copy) through Node's
// vm module, since Model.js has no QML dependency beyond `.pragma library`.
// Every icon state is read from a fixed fleet document in tests/fixtures/.
// Run: node tests/test_model.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function loadModel() {
  const source = fs
    .readFileSync(path.join(ROOT, "Model.js"), "utf8")
    .replace(/^\.pragma library\s*/m, ""); // not valid outside QML
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "Model.js" });
  return sandbox;
}

const Model = loadModel();

let failures = 0;
let checks = 0;

function check(name, condition) {
  checks++;
  if (condition) {
    console.log("PASS " + name);
  } else {
    console.log("FAIL " + name);
    failures++;
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fixtureText(name) {
  return fs.readFileSync(path.join(ROOT, "tests", "fixtures", name + ".json"), "utf8");
}

const NOW = Date.parse("2026-01-15T10:00:00Z");
const HOUR = 3600 * 1000;
const NOT_SEEN = 2 * HOUR;

// A state as it is right after a check made at `NOW` found this fixture.
function checked(name, exitCode) {
  const run = Model.interpretRun(exitCode === undefined ? 0 : exitCode, fixtureText(name));
  return Model.nextState(null, run, NOW);
}

function summary(name, exitCode, nowMs) {
  return Model.summarize(checked(name, exitCode), nowMs === undefined ? NOW : nowMs, NOT_SEEN);
}

// ----------------------------------------------------------- the icon states

function run_icon_states() {
  const green = summary("green");
  check("every host ok: green", green.level === "green");
  check("every host ok: nothing counted", green.count === 0);
  check("every host ok: one row per host", same(green.rows.map((r) => r.name), ["box", "laptop", "server"]));

  const conflict = summary("conflict");
  check("a conflict: amber", conflict.level === "amber");
  check("a conflict: counts that host", conflict.count === 1);
  check("a conflict: the row says how many", conflict.rows[2].label === "2 conflicts");
  check("a conflict: the row names the first one", conflict.rows[2].firstConflict === "link ~/.claude/CLAUDE.md");
  check("a conflict: a host without any shows no name", conflict.rows[0].firstConflict === "");

  const older = summary("conflict-older-fleet");
  check("older fleet: still amber, counting that host", older.level === "amber" && older.count === 1);
  check("older fleet: the row shows the count alone", older.rows[2].label === "2 conflicts" && older.rows[2].firstConflict === "");

  const timer = summary("timer-inactive");
  check("an inactive timer: amber", timer.level === "amber");
  check("an inactive timer: the row says so", timer.rows[0].label === "timer inactive");

  const unreachable = summary("unreachable", 3);
  check("an unreachable host: red", unreachable.level === "red");
  check("an unreachable host: counts that host", unreachable.count === 1);
  check("an unreachable host: the row says so", unreachable.rows[0].label === "unreachable");

  const error = summary("error", 1);
  check("a host in error: red", error.level === "red");

  const mixed = summary("mixed", 3);
  check("red beats amber", mixed.level === "red");
  check("the count is every host that is not green", mixed.count === 2);

  const notQueried = summary("not-queried");
  check("a host fleet cannot ask has no say: green", notQueried.level === "green");
  check("a host fleet cannot ask is not counted", notQueried.count === 0);

  const none = Model.summarize(Model.emptyState(), NOW, NOT_SEEN);
  check("no data: dim", none.level === "dim");
  check("no data: nothing counted", none.count === 0);
}

function run_not_seen_threshold() {
  const state = checked("green");
  const just = Model.summarize(state, NOW + NOT_SEEN, NOT_SEEN);
  check("seen exactly at the threshold is still green", just.level === "green");
  const late = Model.summarize(state, NOW + NOT_SEEN + 1000, NOT_SEEN);
  check("a host not seen for over the threshold: amber", late.level === "amber");
  check("every stale host is counted", late.count === 3);
  check("the row says how long", late.rows[0].label === "not seen 2h");

  const longer = Model.summarize(state, NOW + NOT_SEEN + 1000, 3 * HOUR);
  check("a longer threshold keeps it green", longer.level === "green");

  // A host that stopped answering keeps the time it last did.
  const later = Model.nextState(state, Model.interpretRun(3, fixtureText("unreachable")), NOW + 3 * HOUR);
  check("an unreachable host keeps its last seen time", later.lastSeen.box === NOW);
  check("a host that answered is seen at the new check", later.lastSeen.laptop === NOW + 3 * HOUR);
  const rows = Model.summarize(later, NOW + 3 * HOUR, NOT_SEEN).rows;
  check("an unreachable row says when it was last seen", rows[0].seen === "3h ago");
}

function run_row_detail() {
  const rows = summary("mixed", 3).rows;
  check("a row gives the timer of a host that answered", rows[1].timer === "timer active");
  check("a row gives the last apply of a host that answered", rows[1].applied === "applied 10m ago");
  check("an unreachable host has no last apply", rows[0].applied === "");
  check("an unreachable host says it was never seen", rows[0].timer === "never seen");
  check("this host is marked", rows[1].local === true && rows[0].local === false);
  check("a host fleet cannot ask says how it applies", summary("not-queried").rows[0].timer === "applies on its own schedule");
  check("a host in error says why", summary("error", 1).rows[2].timer === "never seen, its output was not a fleet status document (exit 1)");
}

function run_last_apply_age_advances() {
  const state = checked("green");
  const rows = Model.summarize(state, NOW + 30 * 60 * 1000, NOT_SEEN).rows;
  check("last apply is the age fleet reported", Model.summarize(state, NOW, NOT_SEEN).rows[1].applied === "applied 10m ago");
  check("last apply ages with the time since the check", rows[1].applied === "applied 40m ago");
}

// ------------------------------------------------------------------- parsing

function run_interpret_run() {
  check("exit 127 means fleet is not installed", Model.interpretRun(127, "").kind === "missing");
  check("a machine without a host name has no host", Model.interpretRun(0, fixtureText("no-host")).kind === "nohost");
  check("output that is not a document is a failed check", Model.interpretRun(1, "boom").kind === "failed");
  check("a failed check names the exit code only", Model.interpretRun(2, "").message === "fleet status gave no document (exit 2)");
  check("a document that is not fleet's is a failed check", Model.interpretRun(0, "[1,2]").kind === "failed");
  check("an unreachable host still gives a document", Model.interpretRun(3, fixtureText("unreachable")).kind === "ok");
  check("too much output is refused", Model.interpretRun(0, new Array(1024 * 1024 + 2).join("x")).kind === "failed");

  const model = Model.interpretRun(0, fixtureText("green")).model;
  check("this host is named", model.host === "laptop");
  check("the config commit is the short one", model.config === "8e1b7c4");
}

function run_hostile_documents() {
  const doc = JSON.parse(fixtureText("green"));
  doc.hosts[0].status.timer = "act\u001b[31mive";
  doc.hosts[1].host = "x".repeat(500);
  doc.hosts[2].status.conflicts = "many";
  doc.hosts[2].status.applied.ageSeconds = -4;
  doc.hosts[2].result = "melted";
  doc.hosts.push("nonsense", null, { host: "" });
  const model = Model.interpretRun(0, JSON.stringify(doc)).model;
  check("control characters are replaced", model.hosts[0].timer === "act?[31mive");
  check("a long host name is cut", model.hosts[1].name.length === 64);
  check("a conflict count that is not a number is unknown", model.hosts[2].conflicts === null);
  check("a negative age is unknown", model.hosts[2].appliedAgeSeconds === null);
  check("an unknown result is an error", model.hosts[2].result === "error");
  check("entries that are not hosts are dropped", model.hosts.length === 3);

  const lists = JSON.parse(fixtureText("conflict"));
  const status = (i) => lists.hosts[i].status;
  status(0).conflictList = "link ~/.claude/CLAUDE.md";
  status(1).conflictList = [null, { kind: "link" }];
  status(2).conflictList = [{ kind: "li\u001bnk" + "k".repeat(100), path: "~/a\u0007b/" + "p".repeat(200) }];
  const hostile = Model.interpretRun(0, JSON.stringify(lists)).model;
  check("a conflict list that is not a list names nothing", hostile.hosts[0].firstConflict === "");
  check("a first entry without a path keeps only its kind", hostile.hosts[1].firstConflict === "");
  check("a conflict name is cleaned and cut", /^li\?nkk{11} ~\/a\?b\/p{54}$/.test(hostile.hosts[2].firstConflict));
  status(0).conflicts = 0;
  status(0).conflictList = [{ kind: "link", path: "~/x" }];
  check("a list beside a count of none names nothing", Model.interpretRun(0, JSON.stringify(lists)).model.hosts[0].firstConflict === "");

  const many = JSON.parse(fixtureText("green"));
  for (let i = 0; i < 200; i++) many.hosts.push({ host: "h" + i, result: "ok", status: many.hosts[0].status });
  check("the number of hosts is capped", Model.interpretRun(0, JSON.stringify(many)).model.hosts.length === 64);
}

function run_secrets_never_reach_the_model() {
  const doc = JSON.parse(fixtureText("conflict"));
  const SECRET = "sk-live-4242424242424242";
  doc.token = SECRET;
  doc.hosts[2].status.env = { API_KEY: SECRET };
  doc.hosts[2].status.tools.sops = SECRET;
  doc.hosts[2].status.conflicts = 1;
  doc.hosts[2].status.conflictList = [{ kind: "key", path: "mcp.search", detail: "value was " + SECRET, fix: SECRET }];
  const run = Model.interpretRun(0, JSON.stringify(doc));
  const state = Model.nextState(null, run, NOW);
  const everything = JSON.stringify(Model.summarize(state, NOW, NOT_SEEN)) + Model.serializeState(state) + JSON.stringify(run);
  check("no secret value is kept, shown or saved", everything.indexOf(SECRET) === -1);
  check("a listed conflict is named by kind and path", state.model.hosts[2].firstConflict === "key mcp.search");
  check("a listed conflict gives the count", state.model.hosts[2].conflicts === 1);
}

// --------------------------------------------------------------------- state

function run_next_state() {
  const good = checked("conflict");
  const failed = Model.nextState(good, Model.interpretRun(1, "boom"), NOW + HOUR);
  check("a failed check keeps the last result", failed.model === good.model && failed.checkedAtMs === NOW);
  check("a failed check is remembered", failed.error !== "");
  check("a failed check keeps the icon showing", Model.isVisible(failed));
  const healed = Model.nextState(failed, Model.interpretRun(0, fixtureText("green")), NOW + 2 * HOUR);
  check("a good check clears the failure", healed.error === "" && healed.checkedAtMs === NOW + 2 * HOUR);

  const gone = Model.nextState(good, Model.interpretRun(127, ""), NOW + HOUR);
  check("fleet gone: nothing is kept", gone.model === null && gone.unavailable === "missing");
  check("fleet gone: the widget hides", !Model.isVisible(gone));
  const nohost = Model.nextState(good, Model.interpretRun(0, fixtureText("no-host")), NOW + HOUR);
  check("no host: the widget hides", !Model.isVisible(nohost) && nohost.unavailable === "nohost");

  check("before the first check there is nothing to show", !Model.isVisible(Model.emptyState()));
  const firstFailed = Model.nextState(null, Model.interpretRun(1, "boom"), NOW);
  check("a first check that failed shows a dim icon", Model.isVisible(firstFailed) && Model.summarize(firstFailed, NOW, NOT_SEEN).level === "dim");
}

function run_saved_state() {
  const state = checked("mixed", 3);
  const back = Model.restoreState(Model.serializeState(state));
  check("a saved result comes back whole", same(back, state));
  check("the saved result keeps its age", back.checkedAtMs === NOW);
  check("the saved result gives the same icon", Model.summarize(back, NOW, NOT_SEEN).level === "red");
  check("the saved result is visible straight away", Model.isVisible(back));

  check("an empty file is an empty state", same(Model.restoreState(""), Model.emptyState()));
  check("garbage is an empty state", same(Model.restoreState("{{{"), Model.emptyState()));
  check("another version is an empty state", same(Model.restoreState('{"version":2,"model":{"hosts":[]}}'), Model.emptyState()));

  const tampered = JSON.parse(Model.serializeState(state));
  tampered.model.hosts[0].name = "bad\u0007name";
  tampered.model.hosts[1].conflicts = -1;
  tampered.lastSeen.ghost = NOW;
  const restored = Model.restoreState(JSON.stringify(tampered));
  check("a saved result is cleaned as it is read", restored.model.hosts[0].name === "bad?name" && restored.model.hosts[1].conflicts === null);
  check("seen times of unknown hosts are dropped", restored.lastSeen.ghost === undefined);
}

function run_check_timing() {
  const interval = 15 * 60 * 1000;
  check("no earlier check: soon after start", Model.nextCheckDelayMs(0, NOW, interval) === 5000);
  check("a recent check: waits out the interval", Model.nextCheckDelayMs(NOW, NOW + 5 * 60 * 1000, interval) === 10 * 60 * 1000);
  check("an old check: soon after start", Model.nextCheckDelayMs(NOW, NOW + 3 * HOUR, interval) === 5000);
  check("a check dated in the future: never waits past the interval", Model.nextCheckDelayMs(NOW + HOUR, NOW, interval) === interval);
}

// ------------------------------------------------------------------ settings

function run_settings() {
  const d = Model.resolveSettings({});
  check("default check interval is 15 minutes", d.checkIntervalMs === 15 * 60 * 1000);
  check("default not-seen threshold is 2 hours", d.notSeenMs === 2 * HOUR);
  check("default fleet command is fleet", same(d.fleet, ["fleet"]));
  check("default terminal command is the focus-or-launch one", same(d.terminal, ["omarchy-launch-or-focus-tui"]));
  check("the icon is lit by default", d.unlit === false);

  const s = Model.resolveSettings({ checkIntervalMinutes: "5", notSeenHours: 6, iconAlwaysUnlit: "true", fleetCommand: "/opt/x/bin/fleet" });
  check("settings are read", s.checkIntervalMs === 5 * 60 * 1000 && s.notSeenMs === 6 * HOUR && s.unlit === true && same(s.fleet, ["/opt/x/bin/fleet"]));

  const odd = Model.resolveSettings({ checkIntervalMinutes: 0, notSeenHours: "soon" });
  check("an interval out of range is clamped", odd.checkIntervalMs === 60 * 1000);
  check("a threshold that is not a number is the default", odd.notSeenMs === 2 * HOUR);

  const unsafe = ["fleet; rm -rf ~", "fleet $(id)", "fleet `id`", "fleet | cat", "fleet 'x'", "fleet && x", "--help", "fleet > /tmp/x"];
  unsafe.forEach(function (cmd) {
    check("an unsafe fleet command falls back: " + cmd, same(Model.resolveSettings({ fleetCommand: cmd }).fleet, ["fleet"]));
    check("an unsafe terminal command falls back: " + cmd, same(Model.resolveSettings({ terminalCommand: cmd }).terminal, ["omarchy-launch-or-focus-tui"]));
  });
  check("a blank command falls back", same(Model.resolveSettings({ fleetCommand: "   " }).fleet, ["fleet"]));
  ["fleet push", "fleet apply", "fleet secrets", "fleet update", "fleet doctor", "fleet status", "fleet bridge", "mise exec -- fleet push"].forEach(function (cmd) {
    check("a fleet command that names a fleet subcommand falls back: " + cmd, same(Model.resolveSettings({ fleetCommand: cmd }).fleet, ["fleet"]));
  });
  check("a wrapper around fleet is kept", same(Model.resolveSettings({ fleetCommand: "mise exec -- fleet" }).fleet, ["mise", "exec", "--", "fleet"]));
  check("a command with arguments is kept as words", same(Model.resolveSettings({ terminalCommand: "my-launcher --tui" }).terminal, ["my-launcher", "--tui"]));
}

// ------------------------------------------------------------------ commands

function run_status_command() {
  const cmd = Model.statusCommand(["fleet"]);
  check("the status command is sh running fleet status --all --json", same(cmd.slice(4), ["fleet", "status", "--all", "--json"]));
  check("fleet is handed to the script as an argument", cmd[0] === "sh" && cmd[1] === "-c" && cmd[3] === "sh");
  check("the script never names a fleet subcommand", Model.statusCommand(["fleet"])[2].indexOf("status") === -1);
  const verbs = ["apply", "init", "push", "update", "adopt", "secrets", "doctor", "diff", "skills"];
  check("no other fleet command is built", verbs.every((v) => cmd.indexOf(v) === -1));
}

function run_bridge_commands() {
  const s = Model.resolveSettings({});
  check("Home opens the bridge", same(Model.bridgeCommand(s, {}), ["omarchy-launch-or-focus-tui", "fleet", "bridge"]));
  check("no target opens Home", same(Model.bridgeCommand(s), ["omarchy-launch-or-focus-tui", "fleet", "bridge"]));
  check("a host row opens that host", same(Model.bridgeCommand(s, { host: "server" }), ["omarchy-launch-or-focus-tui", "fleet", "bridge", "--host", "server"]));
  check("c opens Conflicts", same(Model.bridgeCommand(s, { view: "conflicts" }), ["omarchy-launch-or-focus-tui", "fleet", "bridge", "--view", "conflicts"]));
  check("the fleet command setting is used", same(Model.bridgeCommand(Model.resolveSettings({ fleetCommand: "/x/bin/fleet" }), {}), ["omarchy-launch-or-focus-tui", "/x/bin/fleet", "bridge"]));
  check("no other screen can be asked for", Model.bridgeCommand(s, { view: "push" }) === null && Model.bridgeCommand(s, { view: "secrets" }) === null);

  const hostile = ["a b", "a;b", "$(id)", "-x", "", "a/b", "x".repeat(64), "é", "a\nb"];
  hostile.forEach(function (name) {
    check("a host name that is not plain is refused: " + JSON.stringify(name), Model.bridgeCommand(s, { host: name }) === null);
  });
  check("dots, dashes and digits are plain", Model.bridgeCommand(s, { host: "box-2.lan" }) !== null);
  const verbs = ["apply", "init", "push", "update", "adopt", "secrets", "doctor"];
  const all = [Model.bridgeCommand(s, {}), Model.bridgeCommand(s, { host: "server" }), Model.bridgeCommand(s, { view: "conflicts" })];
  check("every action is a bridge, nothing that pushes or runs doctor", all.every((c) => c.indexOf("bridge") === 2 && verbs.every((v) => c.indexOf(v) === -1)));
}

// Whatever the settings and the target, fleet runs only `status --all --json` or `bridge`, which read until a
// person confirms in the bridge. Nothing the plugin starts can apply, push or touch a secret.
function run_only_reading_commands() {
  const settings = ["", "fleet", "/x/bin/fleet", "mise exec -- fleet", "fleet push", "fleet apply", "fleet; rm -rf ~"]
    .map((fleet) => Model.resolveSettings({ fleetCommand: fleet, terminalCommand: "push apply" }));
  const targets = [undefined, {}, { host: "server" }, { view: "conflicts" }, { view: "push" }, { host: "apply" }];
  const built = [];
  settings.forEach(function (s) {
    built.push({ fleet: s.fleet, rest: Model.statusCommand(s.fleet).slice(4 + s.fleet.length) });
    targets.forEach(function (t) {
      const cmd = Model.bridgeCommand(s, t);
      if (cmd !== null) built.push({ fleet: s.fleet, rest: cmd.slice(s.terminal.length + s.fleet.length) });
    });
  });
  const allowed = (rest) => same(rest, ["status", "--all", "--json"]) || (rest[0] === "bridge" && (rest.length === 1
    || (rest.length === 3 && ((rest[1] === "--view" && rest[2] === "conflicts") || (rest[1] === "--host" && Model.isHostName(rest[2]))))));
  check("every command the plugin builds is fleet status --all --json or fleet bridge", built.length > 0 && built.every((b) => allowed(b.rest)));
  check("the fleet program never names a fleet subcommand", built.every((b) => b.fleet.every((t) => ["status", "bridge", "apply", "push", "secrets"].indexOf(t) === -1)));
}

// The QML starts processes only through Model.js, so the tests above see every command it can run.
function run_qml_starts_only_model_commands() {
  const root = path.join(__dirname, "..");
  const starts = [];
  fs.readdirSync(root).filter((f) => f.endsWith(".qml")).forEach(function (file) {
    fs.readFileSync(path.join(root, file), "utf8").split("\n").forEach(function (line) {
      if (/\bcommand\s*[:=]|exec(Detached)?\s*\(|startDetached|Process\s*\{/.test(line)) starts.push(file + ": " + line.trim());
    });
  });
  const known = [
    "Service.qml: statusProc.command = Model.statusCommand(root.config.fleet);",
    "Service.qml: var command = Model.bridgeCommand(root.config, target);",
    "Service.qml: if (command !== null) Quickshell.execDetached(command);",
    "Service.qml: Process {",
    "Service.qml: Process {",
    "Service.qml: command: [\"mkdir\", \"-p\", root.stateDir]",
  ];
  check("the QML starts processes only through Model.js (and mkdir for its state): " + JSON.stringify(starts), same(starts.slice().sort(), known.slice().sort()));
}

function run_headline() {
  check("all ok", Model.headline(summary("green"), "") === "All 3 hosts ok");
  check("some need attention", Model.headline(summary("mixed", 3), "") === "2 of 3 hosts need attention");
  check("one needs attention", Model.headline(summary("conflict"), "") === "1 of 3 hosts need attention");
  check("nothing yet", Model.headline(Model.summarize(Model.emptyState(), NOW, NOT_SEEN), "") === "No fleet data yet");
  check("a failed first check", Model.headline(Model.summarize(Model.emptyState(), NOW, NOT_SEEN), "x") === "Fleet check failed");
}

run_only_reading_commands();
run_qml_starts_only_model_commands();
run_icon_states();
run_not_seen_threshold();
run_row_detail();
run_last_apply_age_advances();
run_interpret_run();
run_hostile_documents();
run_secrets_never_reach_the_model();
run_next_state();
run_saved_state();
run_check_timing();
run_settings();
run_status_command();
run_bridge_commands();
run_headline();

console.log("");
if (failures > 0) {
  console.log("FAILED: " + failures + " of " + checks + " checks");
  process.exit(1);
}
console.log("all " + checks + " checks passed");
