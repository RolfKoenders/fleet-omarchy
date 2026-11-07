# Fleet Omarchy plugin

Development notes for the Fleet plugin for the Omarchy bar.

## Architecture

```
fleet-omarchy/
├── manifest.json          # service + bar-widget, and the settings schema
├── Service.qml            # runs `fleet status --all --json`, keeps the last result, opens the bridge
├── Panel.qml              # bar icon, count and popup; hides itself when there is nothing to show
├── HostRow.qml            # one host in the popup
├── Model.js               # pure functions: parsing, classifying, state, settings, command lines
└── tests/
    ├── test_model.js      # runs Model.js under Node against tests/fixtures/
    ├── test_qml_style.py  # QML house style
    ├── fixtures/          # made-up fleet documents, one per icon state
    └── fixture-fleet      # stands in for `fleet` to preview the plugin
```

## Rules

- The plugin runs one fleet command: `fleet status --all --json`, through `statusCommand()` in `Model.js`. Everything else it starts is `fleet bridge`, through the terminal launcher and `bridgeCommand()`. Nothing may push, apply, run doctor or write anything of fleet's.
- Put decisions in `Model.js`, not in QML, and test them. It must stay free of QML types and Node-only APIs, so the same file runs in both.
- `omarchy-launch-or-focus` runs its command through `eval`. Host names and the two command settings are checked in `Model.js` (`isHostName`, `splitCommand`) before they reach it. Keep it so.
- The document fleet prints is untrusted: read only the fields the panel shows, cut and clean their text, never keep the rest.
- Fixtures use made-up hosts (`laptop`, `server`, `box`). No real host names, paths or addresses in this repo.
- Every `Text` sets `textFormat: Text.PlainText` and an explicit `font.family`. Colours come from the theme; the two fixed state colours are marked `// semantic` (themes have no success or warning colour).
- No em dashes anywhere.

## Verification

```bash
node tests/test_model.js
python3 tests/test_qml_style.py
omarchy plugin validate .
qmllint Service.qml Panel.qml HostRow.qml
```

Then in the real shell: link the checkout into `~/.config/omarchy/plugins/`, `omarchy restart shell` (a hot reload can leave the old service running), and set `fleetCommand` to `tests/fixture-fleet` to see each state.
