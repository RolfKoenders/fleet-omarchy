import QtQuick
import Quickshell
import Quickshell.Io

import "Model.js" as Model

// The one place the plugin touches fleet. It runs `fleet status --all --json`
// on an interval and on demand, keeps the last result in its own state file,
// and opens the bridge through the terminal launcher. It never runs another
// fleet command and writes nothing of fleet's.
Item {
  id: root

  // Pushed in by the bar widget, which is where Omarchy hands over settings.
  property var settings: ({})

  readonly property var config: Model.resolveSettings(settings)
  property var data: Model.emptyState()
  property bool checking: false
  // Read by the icon so a host that goes quiet turns amber without a check.
  property double nowMs: Date.now()

  readonly property var summary: Model.summarize(data, nowMs, config.notSeenMs)
  readonly property bool available: Model.isVisible(data)
  readonly property string headline: Model.headline(summary, data.error)

  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy"
  readonly property string statePath: stateDir + "/io.github.rolfkoenders.fleet.json"
  readonly property int maxStdoutBytes: 1024 * 1024

  property bool loaded: false
  property int exitCode: -1
  property string stdoutBuf: ""
  property bool overflowed: false

  function checkNow() {
    if (root.checking || !root.loaded) return;
    root.checking = true;
    root.stdoutBuf = "";
    root.overflowed = false;
    root.exitCode = -1;
    statusProc.command = Model.statusCommand(root.config.fleet);
    statusProc.running = true;
    killTimer.restart();
  }

  function finishCheck() {
    killTimer.stop();
    var code = root.overflowed ? 1 : root.exitCode;
    var run = root.overflowed ? { kind: "failed", message: "fleet status printed too much" } : Model.interpretRun(code, root.stdoutBuf);
    root.stdoutBuf = "";
    root.data = Model.nextState(root.data, run, Date.now());
    root.nowMs = Date.now();
    root.checking = false;
    stateFile.setText(Model.serializeState(root.data));
    root.schedule();
  }

  function schedule() {
    checkTimer.interval = Model.nextCheckDelayMs(root.data.checkedAtMs, Date.now(), root.config.checkIntervalMs);
    checkTimer.restart();
  }

  // target: {} for Home, {view: "conflicts"}, {host: "name"}.
  function openBridge(target) {
    var command = Model.bridgeCommand(root.config, target);
    if (command !== null) Quickshell.execDetached(command);
  }

  // A different fleet command is a different answer, so it is asked at once;
  // any other setting only moves the next check.
  property string fleetKey: ""

  onConfigChanged: {
    if (!root.loaded || root.checking) return;
    var key = root.config.fleet.join(" ");
    if (key !== root.fleetKey) {
      root.fleetKey = key;
      root.checkNow();
    } else {
      root.schedule();
    }
  }

  Process {
    id: statusProc

    stdout: SplitParser {
      // An empty marker hands over whatever each read returns, instead of
      // waiting for a newline in a document that is mostly one line.
      splitMarker: ""
      onRead: function(value) {
        if (root.overflowed) return;
        var next = root.stdoutBuf + value;
        if (next.length > root.maxStdoutBytes) {
          root.overflowed = true;
          if (statusProc.running) statusProc.signal(15);
          return;
        }
        root.stdoutBuf = next;
      }
    }

    // The exit code can arrive before the last of stdout does, so it is only
    // noted here and the result is read once the process has fully stopped.
    onExited: function(exitCode, exitStatus) {
      root.exitCode = exitCode;
    }

    onRunningChanged: if (!running && root.checking) root.finishCheck()
  }

  // `fleet status --all` waits on ssh, which can hang on a bad network.
  Timer {
    id: killTimer
    interval: 180000
    repeat: false
    onTriggered: if (statusProc.running) statusProc.signal(15)
  }

  Timer {
    id: checkTimer
    repeat: false
    onTriggered: {
      root.checkNow();
      // A check that was skipped because one is already running reschedules
      // itself when that one finishes.
      if (!root.checking) root.schedule();
    }
  }

  Timer {
    interval: 60000
    running: true
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  // ------------------------------------------------------- saved last result

  Process {
    id: ensureDir
    command: ["mkdir", "-p", root.stateDir]
    onRunningChanged: if (!running && !root.loaded) stateFile.reload()
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    // FileView can report a load more than once while it starts up.
    onLoaded: root.start(text())
    onLoadFailed: root.start("")
  }

  function start(text) {
    if (root.loaded) return;
    root.data = Model.restoreState(text);
    root.loaded = true;
    root.fleetKey = root.config.fleet.join(" ");
    root.schedule();
  }

  Component.onCompleted: ensureDir.running = true
}
