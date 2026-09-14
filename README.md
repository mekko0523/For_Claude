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

## Discord コミュニティサーバー連携

`fc26_watch` に加えて、FC26 オンラインコミュニティ向けの Discord サーバーを
一括構築し、新着情報を Discord にも自動投稿する機能があります。

### サーバー構成

`fc26_watch/discord_structure.py` に定義されています。

- **雑談**: `雑談` / `自己紹介`
- **お知らせ**（Bot 専用・一般メンバーは書き込み不可）:
  - `アップデート情報`（パッチノート等の一般ニュース）
  - `EVO情報`（Evolutions）
  - `選手情報・SBC`（SBC / Objectives。いずれも選手カード獲得手段のため統合）
- **対戦・チームメイト募集**: クラブ / グラウンズ / アルティメットそれぞれに
  「対戦相手募集」「チームメイト募集」の計6チャンネル
  （対象コンソールは投稿内でタグ付けする運用を想定し、チャンネルは分けていません）
- **ボイスチャンネル**: `ボイス1` 〜 `ボイス10`

新着情報の3分類は、futbin.com / fut.gg から実際に取得できる URL 構造
（`/evolutions/...` `/sbc/...` `/objectives/...` `/news/...`）を元に
`fc26_watch/fetcher.py` の `categorize_path` で機械的に判定しています。

### セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) で
   アプリケーションと Bot を作成し、Bot トークンを発行。
   Bot 招待時には `Manage Channels`（チャンネル作成）
   `Send Messages` `Embed Links`（通知投稿）権限を付与してください。
2. このリポジトリの Secrets に `DISCORD_BOT_TOKEN` を登録。
3. `Actions` タブ → `FC26 Discord Server Setup` → `Run workflow` から、
   対象サーバーの Guild ID を入力して実行。
   カテゴリ・チャンネルを作成し（既存のものは重複作成せずスキップ）、
   お知らせ3チャンネルのIDを `discord_channels.json` に保存してリポジトリへ
   自動コミットします。
   `discord_structure.py` を編集してチャンネル構成を変えた場合も、この
   ワークフローを再実行すれば差分だけ反映されます。
   `wipe_existing` を ON にすると、実行前にサーバー内の**既存チャンネル・
   カテゴリを全て削除**してから構築します（メッセージ履歴も含め元に戻せない
   ので、他のBotの設定チャンネル等が残っていないか確認の上ご利用ください）。
4. 以降、`FC26 Update Watch` の定期実行時に、新着情報がメールに加えて
   該当する「お知らせ」チャンネルへ自動投稿されます
   （`DISCORD_BOT_TOKEN` 未設定時は Discord への投稿はスキップされます）。

### ローカルでの実行

```bash
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch.discord_setup
```
