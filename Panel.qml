import QtQuick
import qs.Ui
import qs.Commons

import "Model.js" as Model

Panel {
  id: root

  moduleName: "io.github.rolfkoenders.fleet"
  ipcTarget: "io.github.rolfkoenders.fleet"

  readonly property string icon: String.fromCodePoint(0xF233)
  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.55)
  readonly property string family: bar ? bar.fontFamily : Style.font.family

  // Themes have no success or warning colour, so these two are fixed; red is
  // the theme's own urgent colour.
  readonly property color okColor: "#6fae6f"      // semantic
  readonly property color warnColor: "#d9a441"    // semantic
  readonly property color badColor: bar ? bar.urgent : Color.urgent

  // A binding, not Component.onCompleted: `bar` is still null when this
  // Panel is instantiated and is only assigned once the bar mounts it.
  readonly property var service: bar ? bar.shell.serviceFor("io.github.rolfkoenders.fleet") : null

  property double nowMs: Date.now()
  property int cursorIndex: -1

  readonly property var summary: service ? Model.summarize(service.data, nowMs, service.config.notSeenMs) : Model.summarize(Model.emptyState(), nowMs, 0)
  readonly property string error: service ? service.data.error : ""

  function levelColor(level) {
    if (level === Model.GREEN) return root.okColor
    if (level === Model.AMBER) return root.warnColor
    if (level === Model.RED) return root.badColor
    return root.dim
  }

  // The icon is lit in the colour of the fleet, unless the setting keeps it
  // plain. No data, or nothing to say, is the bar's own colour, dimmed.
  readonly property color iconColor: !service || service.config.unlit || service.summary.level === Model.DIM
    ? fg
    : root.levelColor(service.summary.level)

  // Self-hiding, as the built-in agents widget does: the bar collapses a
  // slot whose item is invisible, so a machine without fleet shows nothing.
  visible: !!service && service.available
  implicitWidth: button.implicitWidth + (countText.visible ? countText.implicitWidth + Style.space(6) : 0)
  implicitHeight: button.implicitHeight

  // The widget is the only place Omarchy hands settings to, so they are
  // passed on to the service, which schedules the checks.
  Binding {
    target: root.service
    property: "settings"
    value: root.settings
    when: root.service !== null
  }

  onOpenedChanged: {
    if (root.opened) {
      root.nowMs = Date.now()
      root.cursorIndex = -1
    }
  }

  // A panel left open keeps telling the truth about ages.
  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  function moveCursor(dy) {
    var last = root.summary.rows.length - 1
    root.cursorIndex = Math.max(-1, Math.min(last, root.cursorIndex + dy))
  }

  function openTarget(target) {
    if (!root.service) return
    root.close()
    root.service.openBridge(target)
  }

  function openHome() { root.openTarget({}) }
  function openConflicts() { root.openTarget({ view: "conflicts" }) }

  function openHostAt(index) {
    var rows = root.summary.rows
    if (index < 0 || index >= rows.length || !rows[index].openable) return
    root.openTarget({ host: rows[index].name })
  }

  // Enter opens the selected host, or Home when no row is selected.
  function activateCursor() {
    if (root.cursorIndex < 0) root.openHome()
    else root.openHostAt(root.cursorIndex)
  }

  function checkNow() {
    if (root.service) root.service.checkNow()
  }

  function checkedText() {
    if (!root.service || !root.service.data.checkedAtMs) return "not checked yet"
    return "checked " + Model.formatAge((root.nowMs - root.service.data.checkedAtMs) / 1000)
  }

  function footerText() {
    var parts = []
    if (root.service && root.service.data.model && root.service.data.model.config !== "")
      parts.push("config " + root.service.data.model.config)
    parts.push(root.checkedText())
    return parts.join("  ·  ")
  }

  BarIconButton {
    id: button
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    bar: root.bar
    text: root.icon
    foreground: root.iconColor
    dimmed: !!root.service && root.service.summary.level === Model.DIM
    tooltipText: root.service ? root.service.headline : ""
    onPressed: root.toggle()
  }

  // How many hosts are not green, beside the icon.
  Text {
    id: countText
    visible: !!root.service && root.service.summary.count > 0
    textFormat: Text.PlainText
    anchors.left: button.right
    anchors.leftMargin: -Style.space(2)
    anchors.verticalCenter: parent.verticalCenter
    text: root.service ? String(root.service.summary.count) : ""
    color: root.iconColor
    font.family: root.family
    font.pixelSize: Style.font.body
    font.bold: true

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    open: root.opened
    anchorItem: button
    owner: root
    bar: root.bar
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: root.activateCursor()
      onTextKey: function(t) {
        if (t === "c" || t === "C") root.openConflicts()
        else if (t === "r" || t === "R") root.checkNow()
      }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(10)

        // A click anywhere on the header opens Home.
        Item {
          width: parent.width
          implicitHeight: hero.implicitHeight

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.openHome()
          }

          PanelHero {
            id: hero
            width: parent.width
            title: "Fleet"
            meta: root.service ? root.service.headline : ""
            foreground: root.fg
            fontFamily: root.family

            iconComponent: Text {
              textFormat: Text.PlainText
              text: root.icon
              color: root.iconColor
              font.family: root.family
              font.pixelSize: Style.font.display
            }

            trailingControl: Component {
              PanelActionButton {
                iconText: String.fromCodePoint(0xF021)
                tooltipText: root.service && root.service.checking ? "Checking..." : "Check now"
                foreground: root.fg
                fontFamily: root.family
                enabled: !!root.service && !root.service.checking
                onClicked: root.checkNow()
              }
            }
          }
        }

        PanelSeparator { width: parent.width; foreground: root.fg }

        Text {
          visible: root.error !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.error + (root.summary.rows.length > 0 ? ". Showing the last result." : "")
          color: root.badColor
          font.family: root.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.summary.rows.length === 0
          width: parent.width
          textFormat: Text.PlainText
          text: root.service && root.service.checking ? "Checking every host..." : "No answer from fleet yet."
          color: root.dim
          font.family: root.family
          font.pixelSize: Style.font.body
        }

        Column {
          width: parent.width

          Repeater {
            model: root.summary.rows

            delegate: HostRow {
              required property var modelData
              required property int index

              width: column.width
              hostName: modelData.name
              stateLabel: modelData.label
              stateColor: root.levelColor(modelData.level)
              appliedText: modelData.applied
              timerText: modelData.timer
              conflictText: modelData.firstConflict
              isLocal: modelData.local
              openable: modelData.openable
              foreground: root.fg
              fontFamily: root.family
              hasCursor: index === root.cursorIndex
              onCursorRequested: root.cursorIndex = index
              onOpenRequested: root.openHostAt(index)
            }
          }
        }

        PanelSeparator { width: parent.width; foreground: root.fg }

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: root.service && root.service.checking ? "Checking...  ·  " + root.footerText() : root.footerText()
          color: root.dim
          font.family: root.family
          font.pixelSize: Style.font.caption
        }

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: "enter open  ·  c conflicts  ·  r check now  ·  esc close"
          color: root.dim
          font.family: root.family
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
