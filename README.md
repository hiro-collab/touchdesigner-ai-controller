# TouchDesigner AI Controller

AITuber 本体から独立した、Home Control / MediaPipe / TouchDesigner 連携用の表示 GUI です。

起動:

```powershell
node .\touchdesigner-ai-controller\server.js --workspace C:\Users\kawai\works\sword-voice-agent --port 8788
```

一括起動スクリプトからも起動されます。

```powershell
.\start-home-control-stack.bat -StopExisting
```

表示:

```text
http://127.0.0.1:8788
```

背景は GreenBack です。AITuber Kit (`http://127.0.0.1:3000`) を iframe として全面に読み込み、その上に HUD を重ねます。
文字の雨は標準 OFF です。

より安定した配信用の同一画面は AITuber Kit 側の専用ページを使います。

```text
http://127.0.0.1:3000/touchdesigner-stage
```

ショートカット:

- `H`: HUD 表示/非表示
- `M`: 文字の雨 表示/非表示
- `[` / `]`: フォントサイズ調整
- `C`: アクセントカラー切り替え
- `T`: TouchDesigner にテスト UDP を送信
