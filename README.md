# CODE ORCHESTRA

**Claude が作業しているだけで、ちゃんと音楽になる。**

*English: a Claude Code CLI mod that turns Claude's live work (reads, searches, edits, bash, test results) into synced electronic music and a light show drawn in a terminal pane. Fully local: a self-made synth in Node plays through one `ffplay` process; no network, no API keys. macOS only; the mod API it uses is early access.*

Claude Code CLI の Mod です。Claude の作業イベント（読む・探す・編集する・Bash・テスト・ターン完了）を拍と小節に合わせて編曲し、電子音楽とターミナル内の光のステージに変えます。

- 静かなパッド（和音）とソフトなキックの伴奏から始まります。
- **Read / Grep / Glob** で、次の8分音符にきらめくメロディーが生まれます（光の星が流れます）。
- **Edit / Write** で、次の小節からビートと低音が加わります（床から低音の波が立ちます）。
- **Bash** はコマンドの中身で振り分けます。`cat`・`grep`・`ls` などの読み取りや検索はメロディー、`sed -i` やファイルへの書き込みはビートと低音、テスト実行などそれ以外は次の拍のアルペジオです（auto モードで Claude が Bash 経由で読み書きしても曲になります）。**テスト成功**（テストコマンドの出力にある合格数で判定）は次の小節で LIFT（クラッシュと紙吹雪）になります。
- **失敗やエラー**は警告音ではなく、短調寄りの控えめな陰り（SHADOW）として表現します。
- 人が **Remix** を押すと、次の小節から編曲と映像が切り替わります（GLOW → HALFTIME → ARP STORM → NIGHT DRIVE）。

画面のバッジで入力の出どころを常に示します。**LIVE**＝このCLIでの実際の作業、**REPLAY**＝記録済みの実イベント、**DEMO**＝人工の台本イベントです。

## インストール

```bash
git clone https://github.com/blanket11/code-orchestra.git code-orchestra
cd code-orchestra && npm install   # 型検査用の TypeScript のみ。実行には不要
```

動作要件は **macOS / Claude Code CLI 2.1.299 以降 / Node 24 以降 / ffplay（`brew install ffmpeg`）** です。Claude Code の Mod 機能は早期アクセスの API なので、CLI のバージョンが変わると動かなくなることがあります。`claude plugin install` では動きません（Mod が隣の `engine/` フォルダーを使うため）。リポジトリを clone して、下の `start.sh` か `--plugin-dir` で使います。

どのプロジェクトでも使いたいときは、`~/.zshrc` にエイリアスを足します。

```bash
alias claude-orch='CODE_ORCHESTRA_NODE=$(command -v node) claude --plugin-dir /path/to/code-orchestra/mod'
```

## 起動（iTerm2）

```bash
./scripts/start.sh
```

- デモ用プロジェクト（`fixtures/demo-project` を毎回 `work/demo-project` へ複製し直したもの）で `claude --plugin-dir …/mod` を起動します。自分のプロジェクトで使う場合は `start.sh <ディレクトリ>` とします。
- Pane は自動で開きます。iTerm2 のウィンドウを横110桁以上にすると、会話の横に並びます（ドック表示）。
- 初回だけ、Claude Code がフォルダーの信頼や Chrome 拡張の確認を出すことがあります。その場合は答えてから進めます。

### 操作

`/orchestra` を実行すると、Pane にキーボードが渡ります。`Esc` でプロンプトに戻ります。

| キー | 操作 |
|---|---|
| `s` | Start / Stop（1.5秒のフェードイン、0.8秒のフェードアウト） |
| `r` | Remix（次の小節で切り替え） |
| `d` | DEMO（人工台本、約55秒、終わると LIVE に戻ります） |
| `p` | REPLAY（記録済みの実イベント、約49秒） |
| `l` | LIVE に戻す |
| `j` / `k` | 音量 −10% / +10%（初期値35%） |

マウスでボタンをクリックしても操作できます。Pane を閉じると音はフェードアウトします。CLI を終了するとエンジンも終了します。

### 停止

```bash
./scripts/stop.sh
```

このフォルダーのエンジン（`…/code-orchestra/engine/main.mjs`）だけを止めます。他のプロセスには触れません。`start.sh` も起動時に、親セッションを失ったこの作品のエンジンだけを片付けます。

### 発表前の音出し確認

```bash
./scripts/sound-check.sh
```

DEMO の冒頭6秒を小さめの音量で再生します（afplay）。

## 仕組み

```
Claude Code CLI ──(tool.call / prompt.submit / turn.complete を観測のみ)──▶ Mod (mod/hooks/register.tsx)
   │  種類だけ送信: POST /event {kind}          ▲  JSON 行: その音が「聞こえる時刻」に出す tick
   ▼  Unix ソケット ~/.code-orchestra/run/*.sock │
エンジン (engine/main.mjs, Node)  ── conductor（量子化・編曲）→ synth（合成）── 1本のサンプルクロック
   └─ s16le PCM ─▶ ffplay（1プロセス）─▶ スピーカー
Mod: tick → Raster の光のステージ（66ms ごとに $.ui.blit）＋メーター＋「反映」表示
```

- **受信と発音を分けています。** イベントはキュー（上限32件、同種は合算）に入り、次の8分音符・拍・小節頭で反映されます。1ステップの発音は8音まで、1小節のメロディーは8音までです。作業量は音量ではなく編曲の密度に反映されます。
- **音声エンジンは1つです。** 合成は1本のサンプルクロック上で行い、出力は ffplay 1プロセスへの PCM ストリームです。音符ごとにプロセスを起動することはありません。
- **映像は音に同期します。** エンジンは各16分音符の tick を、その音が聞こえる時刻（出力遅延の推定140ms込み。`CODE_ORCHESTRA_LATENCY_MS` で調整可）に出力します。
- **観測専用です。** フックは `next(e)` の結果をそのまま返し、拒否や書き換えをしません。失敗時の `.catch` は `next(e)` を返します（呼び出し済みなら結果の再生で、ツールを二重実行しません）。送信は待たずに投げっぱなしです。Mod 自身の HTTP やプロセス呼び出しはツールイベントを発生させないため、イベントが増殖することもありません。
- **テスト成功は推測しません。** テスト系のコマンド（`npm test`、`node --test`、`pytest` など）の出力に合格数があり、失敗がない場合だけ成功とします。単に終了コードが0なだけでは成功扱いにしません。
- **安全面:** ソケットは 0600、ディレクトリは 0700 で、TCP ポートは開きません。エンジンは親（CLI）が消えると自分で終了します。別のセッションが再生を始めると、前のセッションの再生は止まります（自作エンジンかをコマンドラインで確かめたうえで、自分のソケット経由で止めます）。記録に残すのはイベントの種類と相対時刻だけで、パス・コマンド・ファイル内容は保存しません。
- **収録用オプション:** 環境変数 `CODE_ORCHESTRA_RECORD_DIR` を設定すると、エンジンが音声の開始時刻と、聞こえた各拍（tick）を時刻付きでそのフォルダーに書き出します。紹介動画の映像と音を合わせるのに使いました。設定しなければ何もしません。
- **ホットリロード・再起動:** モジュールが再読み込みされると、古いエンジンは CLI 側で終了されます。Pane は「stopped」に戻り、二重再生は起きません（pty 実機で確認済み）。

## ファイル

| パス | 内容 | 担当 |
|---|---|---|
| `mod/` | Claude Code Mod（`--plugin-dir` で読み込み）: `hooks/register.tsx`, `classify.ts`, `stage.ts`, `tests/` | Claude |
| `engine/conductor.mjs` | 指揮者: 量子化、レイヤー活性、パターン、Remix、決定的PRNG | Codex（その後 Claude がメロディー輪郭と掛け合いを追加） |
| `engine/timeline.mjs` | REPLAY の時間圧縮、DEMO 台本、プレイヤー | Codex |
| `engine/synth.mjs` | 合成（パッド/ベース/リード/ベル/キック/スネア/ハット/クラップ/クラッシュ、ディレイ、リバーブ） | Claude |
| `engine/performer.mjs` | 指揮者と合成を1本のサンプルクロックで結合、モード切替 | Claude |
| `engine/main.mjs` | 実時間エンジン（ffplay 出力、Unix ソケット制御、tick 出力） | Claude |
| `engine/render.mjs` | オフライン描画と機械検査（ピーク、クリップ、無音、拍位置） | Claude |
| `recordings/` | 実イベントの記録（`capture-*.json` → `replay.json`。`live-latest.json` は LIVE の最新記録） | Mod が記録 |
| `fixtures/demo-project/` | REPLAY 収録と LIVE 実演用の小さなサンプル（わざとバグ入り） | — |
| `scripts/` | `start.sh` `stop.sh` `sound-check.sh` `check.sh` `pty-smoke.py` `make-replay.mjs` `test-sink.sh` | Claude |
| `docs/PRESENTATION_SCRIPT.md` | 60秒の発表台本 | Claude |
| `TEST_RESULTS.md` | 実行したテストと結果 | Claude |

## 検査

```bash
./scripts/check.sh --pty
```

単体テスト、統合テスト、`claude plugin validate`、`claude plugin test`、tsc、音声のオフライン解析、実 CLI の pty スモークをすべて無音で実行します。音声は `test-sink.sh` がファイルに書くだけです。

## 動作要件

- Claude Code CLI 2.1.299 以降（`~/.local/bin/claude`）
- Node 24 以降
- ffplay（`brew install ffmpeg`。`/opt/homebrew/bin/ffplay` で確認）

実行時にネット接続、API キー、追加のモデル呼び出しは使いません。音はすべて自作の合成音です。
