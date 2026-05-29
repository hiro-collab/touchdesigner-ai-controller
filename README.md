# Display Runtime

TouchDesigner control and display-runtime support for the local AITuber projection setup.

## Responsibility

- Provide a small Web GUI for display status and TouchDesigner test triggers.
- Show AITuberKit projection visual in an iframe for projection checks.
- Read display-safe indicators from Environment State Server.
- Subscribe directly to streaming Camera Hub topics where the HUD needs live gesture display.
- Send UDP test payloads to TouchDesigner.

This module does not own Dify decisions, Home Assistant action state, TTS playback, or Camera Hub inference.

## Structure

```text
touchdesigner-ai-controller/
  tools/server.js
  tools/public/
  touchdesigner/
```

The TouchDesigner `.toe` files live under `touchdesigner/`. Generated expansion artifacts should not be treated as hand-written source.

## Start

From the workspace root:

```powershell
.\start-home-control-stack.bat -StopExisting
```

The stack starts AITuberKit, Environment State Server, MediaPipe Camera Hub, Dify watcher, and display-runtime pieces as configured.

To start only the Web GUI:

```powershell
node .\touchdesigner-ai-controller\tools\server.js --workspace <workspace> --port 8788
```

Default bind is `127.0.0.1`.

## TouchDesigner Contract

| Item | Value |
|---|---|
| UDP input | `127.0.0.1:9001` |
| Payload | JSON |
| Typical phases | `start`, `done`, `error` |
| Projection page | `http://127.0.0.1:3000/projection-visual` |
| Cube background | `http://127.0.0.1:3000/cube-vault-background/` |

TouchDesigner should use the UDP payload to start or fade visual effects. It should not infer Home Assistant or Dify state by itself.

## Web GUI

The Display Runtime GUI displays:

- module status
- Home Control events
- legacy Dify compatibility signals when the old stack profile is active
- TouchDesigner UDP destination
- Projection Visual iframe
- HUD overlays

Its long-term data source is Environment State Server `GET /indicators/current`. Streaming Camera Hub topic subscriptions are allowed for live display overlays.

## Remote Access

GUI/API are local by default. To check from another terminal or machine, explicitly opt in with `--host 0.0.0.0 --allow-remote` or `TOUCHDESIGNER_GUI_ALLOW_REMOTE=true`. Trust proxy headers only behind a trusted reverse proxy.

## Shortcuts

- `T`: send test UDP to TouchDesigner.

## toeexpand

Use `toeexpand` only for inspection and review of `.toe` structure. Keep generated expansion artifacts separate from the hand-maintained docs and runtime files.
