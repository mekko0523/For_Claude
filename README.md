# FC26 Update Watch

[futbin.com](https://www.futbin.com/) と [fut.gg](https://www.fut.gg/) を定期的にチェックし、
EA SPORTS FC 26 関連の新着情報（ニュース、パッチノート/タイトルアップデート、SBC、EVO）を
検出したら Gmail 経由でメール通知する仕組みです。GitHub Actions で定期実行します。

## 仕組み

- `fc26_watch/config.py` に監視対象のページと、そのページ内で「新着アイテムへのリンク」を
  見つけるための正規表現パターンを定義しています。
- 実行のたびに各ページを取得し、パターンに一致するリンクを抽出、`state.json` に保存済みの
  URL 一覧と比較して「新しく見つかったリンク」を判定します。
- 新着のうち、タイトルまたは URL に `FC26` / `FC 26` / `FUT26` 等が含まれるものだけを
  メール通知します（`APPLY_FC_VERSION_FILTER=false` で無効化可能。下記「既知の制限」を参照）。
- 初回実行時はメール送信せず、現在存在するリンクをすべて「既知」として `state.json` に
  記録するだけです（そうしないと初回に大量の誤通知が発生するため）。
- `state.json` は GitHub Actions が実行のたびに自動でリポジトリにコミット・push します。

## セットアップ

### 1. Gmail のアプリパスワードを発行

1. 通知の送信元にする Gmail アカウントで 2 段階認証を有効化
2. https://myaccount.google.com/apppasswords でアプリパスワードを発行（16 桁）

### 2. GitHub Secrets を設定

このリポジトリの `Settings > Secrets and variables > Actions` で以下を登録します。

| Secret 名            | 内容                                             |
| --------------------- | ------------------------------------------------ |
| `GMAIL_USER`          | 送信元の Gmail アドレス                          |
| `GMAIL_APP_PASSWORD`  | 上記で発行したアプリパスワード（16 桁）          |
| `MAIL_TO`             | 通知先メールアドレス（複数はカンマ区切り）       |

### 3. ワークフローを有効化

`.github/workflows/fc26-watch.yml` は 30 分おき（`*/30 * * * *`）に自動実行されます。
間隔を変えたい場合は `cron` の値を編集してください。

手動実行やデバッグは `Actions` タブ → `FC26 Update Watch` → `Run workflow` から、
`dump_links` / `dry_run` オプション付きで行えます。

## ローカルでの実行・デバッグ

```bash
pip install -r requirements.txt

# 各ソースページで見つかった全リンクと、パターンにマッチしたかどうかを表示する
python -m fc26_watch.main --dump-links

# メール送信・state.json への保存を行わずに動作確認する
GMAIL_USER=... GMAIL_APP_PASSWORD=... MAIL_TO=... \
  python -m fc26_watch.main --dry-run -v
```

## 既知の制限

- futbin.com / fut.gg は公開ニュース API・RSS を提供していないため、HTML 内のリンクを
  URL パターンでスキャンする方式を採っています。サイトの構造が変わるとリンクが検出できなく
  なることがあります。その場合は `--dump-links` で実際のリンク一覧を確認し、
  `fc26_watch/config.py` の `SOURCES` にある `link_pattern` を更新してください。
- このプロジェクトを作成した実行環境からは futbin.com / fut.gg への直接アクセスができな
  かったため、`link_pattern` は公開情報（検索結果に出てきた URL 例など）から推測した
  ベストエフォートの設定です。**運用開始直後に一度 `--dump-links` で実際のリンク構造を
  確認し、各ソースが期待通り拾えているか確認することを強く推奨します。**
- SBC / EVO のタイトルにはゲームバージョン（`26` など）が含まれないことが多く、
  `APPLY_FC_VERSION_FILTER` が有効だとこれらの新着が通知から漏れる可能性があります。
  SBC/EVO はバージョンを問わず全件通知したい場合は、`fc26_watch/config.py` の該当
  `Source` を分けてフィルタを個別に無効化するか、ワークフローの環境変数で
  `APPLY_FC_VERSION_FILTER=false` を設定してください。
- 2026 年 9 月時点で両サイトは次期タイトル（EA SPORTS FC 27）関連のコンテンツも
  掲載し始めています。FC26 の新着ページが縮小・移動された場合は `config.py` の
  URL を実際のアーカイブ URL に更新する必要があります。
- スクレイピング元サイトの利用規約・robots.txt の範囲内でご利用ください。
