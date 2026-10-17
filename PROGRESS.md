# CODE ORCHESTRA — 進捗メモ（作業再開用）

開始: 2026-10-15 19:18:51 / 納品目標 20:38 / 予算上限 20:48
環境: Claude Code CLI 2.1.299 (~/.local/bin/claude), Codex CLI 0.160.0, Node 24.14.0 (mise), ffplay/ffmpeg (/opt/homebrew/bin)

## 採用構成（決定事項）
- 主対象: iTerm2 の Claude Code CLI に `--plugin-dir code-orchestra/mod` で Mod を読み込む。
- 音: ローカル補助エンジン `engine/main.mjs`（Node、依存なし）が1本のサンプルクロックで合成し、ffplay 1プロセスへ s16le PCM を流す。音符ごとのプロセス起動はしない。
- 制御: Mod → エンジンは Unix ソケット上の HTTP（`~/.code-orchestra/run/<id>.sock`、0600、ディレクトリ 0700）。TCPポートなし。
- 同期: エンジンは各16分ステップの tick を「その音が聞こえる時刻」に stdout へ JSON 行で出す。Mod はそれで Raster を blit（66ms）。
- イベント受信と発音は分離: 指揮者（conductor）が次の8分/4分/小節頭へ量子化。キュー32件上限、1ステップ8音、1小節メロディー8音。
- モード: LIVE（実CLIイベント）/ REPLAY（実記録 recordings/replay.json）/ DEMO（人工台本、timeline.mjs）。同じエンジンへの入力切替。
- エンジンは Mod が `$.process.spawn` で起動 → モジュール解放・CLI終了で終了。親消失ウォッチドッグあり。別セッションが再生を始めると前のエンジンは停止（active.json、自作エンジンのみ確認して対象化）。

## 担当
- Codex: engine/conductor.mjs, engine/timeline.mjs, engine/test/*.test.mjs（32件合格）。その後 Claude がメロディー輪郭・掛け合いを追加。
- Claude: engine/synth.mjs, performer.mjs, main.mjs, render.mjs, mod/ 一式, scripts/, docs/

## 実装済み
- [x] 合成エンジン（pad/bass/lead/bell/kick/snare/hat/clap/crash、ディレイ+リバーブ、tanhソフトクリップ、フェード）
- [x] オフライン描画と機械検査（render.mjs）
- [x] 実時間エンジン（ダミーsinkで開始/停止/再開/remix/demo/quit・ソケット後始末を確認）
- [x] Mod: 観測専用フック、Pane（Raster舞台+メーター+反映表示+ボタン）、/orchestra
- [x] Mod テスト6件（claude plugin test）
- [x] 実イベント記録（claude -p ×2）→ recordings/replay.json
- [x] start/stop/sound-check/check スクリプト、README、docs/PRESENTATION_SCRIPT.md、TEST_RESULTS.md
- [x] pty で実 CLI 確認（Pane 描画、Start/Remix/Demo/Stop/再開、ホットリロード時の旧エンジン停止、LIVE 反映、終了時の後片付け、blit ok）

## 修正履歴（要点）
- ready 通知の type が stateMsg で上書きされていた → 修正。統合テストを追加
- Mod が `mod/../engine` で起動していて stop.sh が照合できなかった → 正規化
- node --test の `ℹ pass N` を成功判定できていなかった → パターン追加
- /orchestra で Pane に focus（ctrl+x tab よりも確実）

## 残課題
- スピーカーでの聴取、iTerm2 での目視（TEST_RESULTS.md 末尾）

## 起動
`code-orchestra/scripts/start.sh`（詳細は README）
