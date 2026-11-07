import QtQuick
import qs.Ui
import qs.Commons

// One host in the panel: a dot in the colour of its state, its name, when it
// last applied and what its timer says, and the first conflict if it has one.
CursorSurface {
  id: root

  required property string hostName
  required property string stateLabel
  required property color stateColor
  required property string appliedText
  required property string timerText
  required property string conflictText
  required property bool isLocal
  required property bool openable
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  readonly property color dim: Qt.darker(foreground, 1.55)

  signal openRequested()
  signal cursorRequested()

  implicitHeight: content.implicitHeight + Style.space(16)

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    enabled: root.openable
    cursorShape: root.openable ? Qt.PointingHandCursor : Qt.ArrowCursor
    onContainsMouseChanged: if (containsMouse) root.cursorRequested()
    onClicked: root.openRequested()
  }

  Item {
    id: content
    anchors.fill: parent
    anchors.margins: Style.space(8)
    implicitHeight: Math.max(texts.implicitHeight, stateText.implicitHeight)

    Rectangle {
      id: dot
      width: Style.space(8)
      height: Style.space(8)
      radius: width / 2
      color: root.stateColor
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.topMargin: Style.space(5)
    }

    Column {
      id: texts
      anchors.left: dot.right
      anchors.leftMargin: Style.space(10)
      anchors.right: stateText.left
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(2)

      Row {
        spacing: Style.space(6)

        Text {
          textFormat: Text.PlainText
          text: root.hostName
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Text {
          textFormat: Text.PlainText
          visible: root.isLocal
          text: "this host"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          anchors.baseline: parent.children[0].baseline
        }
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: [root.appliedText, root.timerText].filter(function(part) { return part !== "" }).join("  ·  ")
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        visible: root.conflictText !== ""
        width: parent.width
        text: root.conflictText
        color: root.stateColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

    Text {
      id: stateText
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.top: parent.top
      text: root.stateLabel
      color: root.stateColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }
  }
}
