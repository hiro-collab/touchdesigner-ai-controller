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

## 初期セットアップ

This organ's Web GUI uses Node.js built-in modules only; there is no local
`package.json` or `npm install` step for `tools/server.js`.

Required local tools/assets:

- Node.js available as `node`.
- AITuberKit Projection Visual already running when iframe projection checks are needed.
- Environment State Server available when display-safe indicators are needed.
- TouchDesigner installed separately if UDP visual triggers are tested.

TouchDesigner `.toe` files are binary project assets. Generated expansion
artifacts, local logs, `.cache/`, and private display captures are local-only
unless explicitly reviewed for publication.

## dotenv / local config

There is no standard `.env.example` for this repo. Runtime settings are read
from CLI args or environment variables such as:

- `HOME_CONTROL_WORKSPACE_ROOT`
- `TOUCHDESIGNER_GUI_HOST`
- `TOUCHDESIGNER_GUI_PORT`
- `TOUCHDESIGNER_UDP_HOST`
- `TOUCHDESIGNER_UDP_PORT`
- `AITUBER_URL` / `NEXT_PUBLIC_AITUBER_URL`
- `DISPLAY_RUNTIME_DEBUG_TRACES`

Keep remote GUI access opt-in with `--allow-remote` or
`TOUCHDESIGNER_GUI_ALLOW_REMOTE=true`.

## 通常起動

From the Agent OS repository root:

```powershell
.\start-home-control-launcher.bat
```

or:

```powershell
pwsh -NoProfile -File .\scripts\start-launcher.ps1 -PortMode isolated_override -OpenBrowser
```

The launcher starts AITuberKit, Environment State Server, MediaPipe Camera Hub,
Thought Core / Dify compatibility pieces, and display-runtime pieces as
configured.

To start only the Web GUI for debugging, pass the same workspace root used by
the launcher:

```powershell
node .\organs\display\touchdesigner-ai-controller\tools\server.js --workspace . --port 8788
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

`GET /api/status` is routine-safe by default: raw speech, user queries, assistant text, local paths, and conversation-log text are replaced with trace summaries. For loopback-only local debugging, use `GET /api/status?debug=1` or set `DISPLAY_RUNTIME_DEBUG_TRACES=true`; long debug text is capped by `DISPLAY_RUNTIME_DEBUG_TRACE_TEXT_LIMIT`.

## Remote Access

GUI/API are local by default. To check from another terminal or machine, explicitly opt in with `--host 0.0.0.0 --allow-remote` or `TOUCHDESIGNER_GUI_ALLOW_REMOTE=true`. Trust proxy headers only behind a trusted reverse proxy.

## Shortcuts

- `T`: send test UDP to TouchDesigner.

## toeexpand

Use `toeexpand` only for inspection and review of `.toe` structure. Keep generated expansion artifacts separate from the hand-maintained docs and runtime files.
