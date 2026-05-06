# TouchDesigner AI Controller

AITuber のアバター映像と背景を重ね、プロジェクター表示向けに色調整と TouchDesigner エフェクトを加える表示・演出プロジェクトです。

主役は `touchdesigner/20260501AITuber.toe` です。TouchDesigner 側で AITuber Kit の表示ページを Web Render TOP として取り込み、クロマキー、色調整、トリミング、オーラ風の流体エフェクトを合成し、Window COMP から外部ディスプレイ/プロジェクターへ出力します。

`tools/server.js` と `tools/public/` は、スタック状態を確認するための軽量な Web GUI です。AITuber Kit、Home Assistant ブリッジ、MediaPipe、Dify、VOICEVOX などの稼働状態を表示し、TouchDesigner への UDP テスト送信も行えます。

## ディレクトリ構成

```text
touchdesigner-ai-controller/
  README.md
  .gitignore
  tools/
    server.js                  # 状態確認 Web GUI / UDP テスト送信用の Node.js サーバー
    public/
      index.html               # Web GUI の画面
      app.js                   # Web GUI の状態取得・表示ロジック
      styles.css               # Web GUI のスタイル
  touchdesigner/
    20260501AITuber.toe        # 現行の TouchDesigner プロジェクト本体
    20260501AITuber.14.toe     # 現行版と同一ハッシュのバックアップ相当
    Backup/                    # TouchDesigner が保存した過去版 .toe
    expanded/
      20260501AITuber.toe.dir/ # toeexpand で展開した解析用ファイル群
      20260501AITuber.toe.toc  # toeexpand の目次
    touchdesigner-mcp-td/
      mcp_webserver_base.tox   # .toe から相対参照される TouchDesigner MCP tox
      modules/                 # MCP / td_server 関連モジュール
```

`tools/` は Web GUI などの補助ツール置き場です。`touchdesigner/` は `.toe` 本体、TouchDesigner MCP 用 tox/モジュール、バックアップ、展開済み解析用ファイルをまとめています。

`touchdesigner/expanded/` は解析用の生成物置き場です。`toeexpand` の出力は大きくなりやすいため、通常は `.gitignore` で除外しています。

## 何をするプロジェクトか

- AITuber Kit の映像を TouchDesigner に取り込む
- アバターと背景をプロジェクター用の画面として合成する
- クロマキー、HSV、Level、Crop などで投影向けに色と構図を調整する
- 家電操作が実行されたタイミングで、アバター周辺にオーラのようなエフェクトを出す
- 映像内で動いているアバター部分から特に強くエフェクトが立ち上がるようにする
- Home Control 系の実行イベントを UDP で受け取り、演出の ON/OFF を切り替える

## 全体の流れ

```text
AITuber Kit
  -> TouchDesigner Web Render TOP
  -> クロマキー/色調整/トリミング
  -> アバターの動き検出
  -> Navier-Stokes 系の fluid エフェクト
  -> 背景/アバター/オーラを合成
  -> Window COMP でプロジェクター出力
```

家電操作側からは `home_control_magic` の UDP JSON を受け取ります。`phase: "start"` でオーラの強度を上げ、`phase: "done"` または `phase: "error"` で消します。

```json
{
  "type": "home_control_magic",
  "phase": "start",
  "action_id": "turn_on_light"
}
```

TouchDesigner 側の受信ポートは `9001` です。

## TouchDesigner 構成

`touchdesigner/20260501AITuber.toe` を `toeexpand` で展開した解析用コピーは、`touchdesigner/expanded/20260501AITuber.toe.dir/project1` 以下にまとめています。

- `webrender1`: `http://127.0.0.1:3000/cube-vault-background/` を 1280x720 で取り込む
- `chroma1` / `chroma2`: グリーンバック系の抜き処理
- `hsvadj1` / `hsvadj2`、`level1`、`crop1` / `crop2`: 投影向けの色と画角の調整
- `UDP_trigger`: UDP イベントで制御される CHOP。`power_aura` の Gain に接続される
- `udpin1`: UDP 9001 を受信し、`udpin1_callbacks` で JSON を処理する
- `latest_payload`: 直近の UDP payload を記録する Text DAT
- `power_aura`: アバターの動きからオーラを生成して合成する Base COMP
- `window1`: `null1` の最終映像を display 2 にボーダーレス/フルスクリーンで出力する

### power_aura

`power_aura` はアバター映像を入力として受け取り、動きの強い部分を検出してオーラの発生源にします。

内部では `diff1` と `cache1` で現在フレームと過去フレームの差分を取り、`feedback1`、`blur1`、`math1` などで残像と強度を整えています。この動きマスクをもとに `fluid/out1_col` の流体色を加工し、元のアバター/背景映像に `over2` で合成します。

`power_aura` の `Gain` は `op('null2')['v1']`、つまり `UDP_trigger` と手動ボタンをまとめた CHOP から制御されます。家電操作イベントが入ると Gain が上がり、オーラが見える状態になります。

### fluid

`project1/power_aura/fluid` は、Navier-Stokes の考え方を TouchDesigner/GLSL TOP で再現した流体シミュレーションです。単なるノイズ素材ではなく、速度場、圧力場、発散、渦度、圧力勾配補正を持つ流体ソルバとして組まれています。

主な GLSL ステップは次の通りです。

- `glsl1` / `glsl2`: 外部入力から色と速度の splat を注入する
- `glsl_curl`: 速度場から curl を計算する
- `glsl_vorticity`: 渦度に基づく力を作る
- `glsl_divergence`: 速度場の発散を計算する
- `glsl_pressure`: 圧力を反復的に解く
- `glsl_gradient`: 圧力勾配を計算し、速度場から差し引く
- `glsl_advect1` / `glsl_advect2`: 速度場と色/密度を移流させる
- `feedback_velocity` / `feedback_pressure` / `feedback_color`: 各場をフレーム間で保持する

これにより、家電操作が実行された瞬間にアバターの動きが「力」として流体に入り、動いている輪郭や髪/体の周辺からオーラが湧くような見え方になります。

## Web GUI

起動:

```powershell
node .\touchdesigner-ai-controller\tools\server.js --workspace C:\Users\kawai\works\sword-voice-agent --port 8788
```

一括起動スクリプトからも起動されます。

```powershell
.\start-home-control-stack.bat -StopExisting
```

この一括起動では、MediaPipe は Camera Hub 構成で起動します。

- `mediapipe_camera_hub`: `mediapipe-sword-sign\apps\serve_camera_hub.py`

Camera Hub が `ws://127.0.0.1:8765` で topic envelope を配信し、AITuber Kit 側は `/vision/sword_sign/state` を購読して刀印による録音制御に使います。通常の一括起動では MediaPipe のGUIは開きません。

Camera Hub の topic を目視確認したい場合だけ、次のように監視GUIも起動します。

```powershell
.\start-home-control-stack.bat -StopExisting -MediapipeMode gui
```

この場合の追加プロセスは `mediapipe_camera_hub_gui` で、実体は `mediapipe-sword-sign\apps\camera_hub_gui.py` です。監視GUIは配信開始ボタンではないため、必要に応じて `Connect` を押して中身を見ます。

旧 `serve_websocket.py` の直JSON互換で切り分けたい場合だけ、次のように起動します。

```powershell
.\start-home-control-stack.bat -StopExisting -MediapipeMode headless
```

表示:

```text
http://127.0.0.1:8788
```

Web GUI は、各サービスの状態、Dify/Home Control の最近のイベント、TouchDesigner UDP 送信先を表示します。MediaPipe は `mediapipe_camera_hub` の PID と `ws://127.0.0.1:8765` のWebSocket handshakeで状態判定します。背景は GreenBack で、AITuber Kit (`http://127.0.0.1:3000`) を iframe として全面に読み込み、その上に HUD を重ねます。文字の雨は標準 OFF です。

GUI/API はローカル運用前提です。既定では `127.0.0.1` に bind し、loopback 以外の Origin は CORS 許可しません。別端末から確認する場合だけ `--host 0.0.0.0 --allow-remote` または `TOUCHDESIGNER_GUI_ALLOW_REMOTE=true` を明示してください。プロキシ配下で運用する場合のみ、接続元ヘッダを信頼する `TOUCHDESIGNER_GUI_TRUST_PROXY_HEADERS=true` を使います。

より安定した投影映像ソースは AITuber Kit 側の Projection Visual ページです。

```text
http://127.0.0.1:3000/projection-visual
```

## ショートカット

- `H`: HUD 表示/非表示
- `M`: 文字の雨 表示/非表示
- `[` / `]`: フォントサイズ調整
- `C`: アクセントカラー切り替え
- `T`: TouchDesigner にテスト UDP を送信

## toeexpand

TouchDesigner の `.toe` は次のように展開できます。

```powershell
Push-Location .\touchdesigner
toeexpand .\20260501AITuber.toe
Pop-Location
```

`toeexpand` は `.toe` と同じ階層に `*.toe.dir/` と `*.toe.toc` を出力します。今回の解析では `touchdesigner/20260501AITuber.toe` を展開し、生成物を `touchdesigner/expanded/20260501AITuber.toe.dir/` と `touchdesigner/expanded/20260501AITuber.toe.toc` に移動しました。

`touchdesigner/20260501AITuber.14.toe` は現行の `touchdesigner/20260501AITuber.toe` と同一ハッシュのバックアップ相当です。`touchdesigner/Backup/` 以下には過去版の `.toe` が保存されています。
