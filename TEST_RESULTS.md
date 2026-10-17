# テスト結果

実施: 2026-10-15 19:18〜19:56 / Claude Code CLI 2.1.299 / Node 24.14.0 / ffplay 8.1 / macOS
再実行: `scripts/check.sh --pty`（全項目を無音で実行し、`work/check-report.txt` に保存）。最終実行の結果は **ALL CHECKS PASSED** でした。

## 自動テスト

| 項目 | コマンド | 結果 |
|---|---|---|
| 指揮者・タイムラインの単体テスト（Codex作成 32件） | `node --test engine/test/*.test.mjs` | 合格（35件中32件） |
| エンジンの統合テスト 3件（実プロセス、ダミー出力） | 同上 | 合格（35件中3件） |
| Mod の静的検証 | `claude plugin validate mod` | 合格（警告は author 未記入のみ）。`tool.call`、`prompt.submit`、`ui.close` は `.catch` 付きの観測フック |
| Mod のテスト 6件 | `claude plugin test mod` | 6件すべて合格 |
| 型検査（strict, noUncheckedIndexedAccess） | `tsc -p mod`（CLI 2.1.299 が書き出した型を使用） | エラー0 |

確認した内容:

- **拍への割り当て:** read は次の8分音符、bash は次の拍、edit・write・テスト・prompt は次の小節頭に反映されます。反映前に鳴ることはありません（単体テスト）。実エンジンでも、read が偶数ステップで melody として鳴ることを確認しました（統合テスト）。
- **イベント集中時の上限:** 1000件を push してもキューは32件以下、1ステップ8音以下、1小節のメロディー8音以下で、音量・エネルギーも範囲内でした。実エンジンに500件を同時 POST してもキューは32件以下でした。
- **無音にならない:** イベントがなくても毎小節パッドが鳴ります。
- **Remix:** 小節の途中で3回押しても、次の小節頭で1段だけ切り替わります。
- **決定性:** 同じ入力なら同じ演奏になり、reset 後も再現します。
- **Mod の観測専用:** 本来のツールは1回だけ実行され、結果も変わりません（成功時・エラー時の両方）。
- **テスト成功の判定:** 終了コード0だけでは成功としません。`ℹ pass 2` / `# pass 5` / `12 passed` などの合格数で判定します。
- **Start でエンジンが1つだけ起動すること:** 起動パスに `..` を含まない（停止スクリプトの照合用）ことも確認しました。
- **Pane の幅への追従:** 24・80・140桁で確認しました。1セル1グリフで、色ペアは1024未満です。
- **エンジンの入出力:** ready の通知、ソケットの権限 0600、未知の種類の拒否、停止・終了後のソケット削除を確認しました。2つ目のエンジンが再生を始めると1つ目が止まることも確認しました。DEMO の表示も確認済みです。

## 音声の機械検査（`engine/render.mjs`、オフライン描画、48kHz ステレオ）

| 条件 | 長さ | ピーク | クリップ | 無音窓（フェード後） | 拍位置 | キック立ち上がり | 最大同時音 |
|---|---|---|---|---|---|---|---|
| DEMO | 62 s | −11.1 dBFS | 0 | 0 | 全ステップが格子上 | 65/65 | 8 |
| REPLAY（実記録） | 60 s | −11.6 dBFS | 0 | 0 | 全ステップが格子上 | 71/71 | 8 |
| イベントなし | 20 s | −20.8 dBFS | 0 | 0 | 全ステップが格子上 | 17/17 | 5 |
| 集中（100msごとに40件） | 20 s | −10.7 dBFS | 0 | 0 | 全ステップが格子上 | 33/33 | 8 |

DEMO では、静かな導入（パッドと柔らかいキック）→メロディー誕生→ビートと低音の追加→Remix→LIFT×2→収束→LIVE 復帰の順に展開することを、小節ごとの集計で確認しました（`scripts/dev/arrangement-by-bar.mjs`）。WAV は `work/out/*.wav` に書き出しています。

## 実際の CLI での確認（擬似端末、`scripts/pty-smoke.py`）

対話型の `claude --plugin-dir mod` を pty で起動しました（150×48、Claude 系の環境変数を外したクリーンな環境）。音声は `test-sink.sh` でファイルに書き出したため、スピーカーからは鳴っていません。

| 段階 | 結果 |
|---|---|
| 起動直後 | Pane「CODE ORCHESTRA [LIVE] … stopped」が描画される。エンジンは0（勝手に鳴らない） |
| `/orchestra` → `s` | エンジン1つ。PCM 約0.96 MB（約5秒分）が流れ、表示は「♪ playing」 |
| `r` → `d` | [DEMO] 表示。PCM が増え続ける |
| `s`（停止）→ `s`（再開始） | エンジンは1つのまま再利用され、増えない |
| Mod のソースを書き換え（ホットリロード） | 旧エンジンは CLI に止められて0になる（`the op was aborted`）。再 Start で1つ |
| LIVE: 実プロンプト「README.md と scale.mjs を読んで ok と答えて」 | prompt・read・turn_end が `POST /event` で届き（200）、Pane に「✓ bar 2.1 Prompt → pad swell」「Turn done → calm」と表示 |
| `/exit` | エンジン0、ffplay 代替0、ソケット0 |
| 映像更新 | デバッグログに `stage blit ok` |

## 実イベントの収録（REPLAY の素材）

`claude -p --plugin-dir mod` を同梱のサンプル（`fixtures/demo-project`）で2回実行し、Mod 自身に記録させました。

- `recordings/capture-1-fix-bug.json`: 9件。prompt → bash → test_fail → … → read → edit → bash → turn_end。この時点ではテスト成功判定に `ℹ pass` 形式がなかったため、最後のテスト成功は bash としてだけ記録されています。この後に判定を修正しました。
- `recordings/capture-2-add-feature.json`: 15件。prompt → test_fail → read×3 → test_fail → edit×4 → **test_pass** → turn_end
- `recordings/replay.json` は、上の2件を順につないだものです（`scripts/make-replay.mjs`）。保存しているのは種類と相対時刻だけです。

## 人の目と耳で残っている確認

- **スピーカーでの実際の聴取:** 音質、音量感、ffplay の実際の遅延と映像のずれ（推定140ms、`CODE_ORCHESTRA_LATENCY_MS` で調整）。無人環境のため、スピーカーで鳴らす試験はしていません。ffplay が PCM パイプの引数を受け付けて音声デバイスを開くことは、無音0.5秒で確認済みです。
- **iTerm2 での見た目:** 今回は pty と同じ CLI での確認です。iTerm2 の画面は取得していません。Raster が iTerm2 で表示されることは、事前検証（docs/RENDER_PROBE_RESULTS.md）で確認されています。
- **狭いウィンドウ（110桁未満）での表示:** Pane が入力欄の上に出る inline 表示は、自動テスト（24桁）でしか確認していません。
