# FC27 Discord Notifier

FUTBIN / FUT.GG / EA SPORTS FC 公式 の最新情報と、X（旧Twitter）で注目されている FC27 関連ポストを定期チェックし、Discord に通知する Bot です。GitHub Actions のスケジュール実行（タイムトリガー）で動きます。

## 通知元

| ソース | 内容 |
| --- | --- |
| FUTBIN | https://www.futbin.com/news の最新記事 |
| FUT.GG | https://www.fut.gg/news/ の最新記事 |
| EA SPORTS FC 公式 | https://www.ea.com/games/ea-sports-fc/fc-27/news の最新記事 |
| X (Twitter) | FC27 関連キーワードの検索結果から、エンゲージメント（いいね・RT等)上位の注目ポスト |

同じ記事・ポストは一度通知したら再通知しません（`data/seen_state.json` に既読リストを保持し、実行のたびに更新・コミットされます）。

## セットアップ

### 1. Discord Webhook を作成

Discord サーバーの通知したいチャンネルで `チャンネルの設定 → 連携サービス → ウェブフック` から Webhook URL を発行します。

### 2. GitHub Secrets を設定

リポジトリの `Settings → Secrets and variables → Actions` で以下を登録します。

- `DISCORD_WEBHOOK_URL`（必須）: 上で発行した Webhook URL
- `X_BEARER_TOKEN`（任意）: X API v2 の Bearer Token。未設定の場合 X のチェックはスキップされます。
  - X API はティア/料金プランによって `recent search` エンドポイントの利用可否が異なります。利用には有効なアクセスレベルの Developer App が必要です。

### 3. タイムトリガー（実行間隔）を指定

`.github/workflows/fc27-notify.yml` の `schedule.cron` を編集してください（UTC 基準）。

```yaml
on:
  schedule:
    - cron: "0 */3 * * *"   # 3時間ごと（デフォルト）
```

例:

- 毎時: `"0 * * * *"`
- 6時間ごと: `"0 */6 * * *"`
- 毎日9時(JST) = 0時(UTC): `"0 0 * * *"`

`Actions` タブから `Run workflow` を選ぶことで、スケジュールを待たずに手動実行（`dry_run` オプション付きも可）できます。

### 4. ソースの有効/無効を切り替える（任意）

ワークフローや Secrets/Variables に以下の環境変数を追加すると、個別のソースを無効化できます（デフォルトは全て有効）。

- `ENABLE_FUTBIN` / `ENABLE_FUTGG` / `ENABLE_EA` / `ENABLE_X` (`true`/`false`)

## ローカルでの実行

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # DISCORD_WEBHOOK_URL などを記入
export $(grep -v '^#' .env | xargs)   # .env を環境変数として読み込む場合

python -m fc27_notifier.main --dry-run   # 取得内容をログ出力するだけ（Discord送信なし・状態未保存）
python -m fc27_notifier.main             # 実際に Discord へ送信し、状態を更新
```

## 注意事項

- FUTBIN / FUT.GG / EA 公式サイトは HTML 構造の変更やボット対策（403 応答など）で取得に失敗することがあります。1ソースの取得失敗は他のソースの通知を止めないよう設計されていますが、失敗が続く場合はスクレイピング対象の HTML 構造の変化を確認し、`fc27_notifier/sources/` 配下の該当ファイルを調整してください。
- X のトレンド判定は「いいね×1 + リツイート×2 + 引用×2 + 返信×1」の簡易スコアで、`X_MIN_ENGAGEMENT`（既定 50）以上のポストのみ通知します。しきい値や検索クエリは環境変数 `X_SEARCH_QUERY` / `X_MIN_ENGAGEMENT` / `X_TOP_N` / `X_MAX_RESULTS` で調整できます。
- 各種サイトの利用規約・robots.txt の範囲内でご利用ください。
