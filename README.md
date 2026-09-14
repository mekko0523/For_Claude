# FC27 Update Watch

[futbin.com](https://www.futbin.com/) と [fut.gg](https://www.fut.gg/) を定期的にチェックし、
EA SPORTS FC 27 関連の新着情報（ニュース、パッチノート/タイトルアップデート、SBC、EVO）を
検出したら Gmail 経由でメール通知する仕組みです。GitHub Actions で定期実行します。

## 仕組み

- `fc26_watch/config.py` に監視対象のページと、そのページ内で「新着アイテムへのリンク」を
  見つけるための正規表現パターンを定義しています。
- 実行のたびに各ページを取得し、パターンに一致するリンクを抽出、`state.json` に保存済みの
  URL 一覧と比較して「新しく見つかったリンク」を判定します。
- 新着のうち、タイトルまたは URL に `FC27` / `FC 27` / `FUT27` 等が含まれるものだけを
  メール通知します（`APPLY_FC_VERSION_FILTER=false` で無効化可能。下記「既知の制限」を参照）。
- 初回実行時はメール送信せず、現在存在するリンクをすべて「既知」として `state.json` に
  記録するだけです（そうしないと初回に大量の誤通知が発生するため）。
- `state.json` は GitHub Actions が実行のたびに自動でリポジトリにコミット・push します。
- 重複投稿の防止は二段構えです。① `state.json` の URL 一覧により、一度投稿したURLは
  何度実行されても再投稿されません。② 同じニュースが futbin.com / fut.gg 双方から
  別URLで報告された場合に備え、同一バッチ内でタイトルが一致するものは1件にまとめます
  （`fc26_watch/main.py` の `dedupe_by_title`）。
- Discordに投稿するニュースのタイトルは、DeepL APIキー（`DEEPL_API_KEY`）が設定されて
  いれば日本語に自動翻訳されます。**リンク自体は常に原文記事のURLのまま**です。
  未設定の場合は原文タイトルのまま投稿されます。

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

`.github/workflows/fc26-watch.yml` は日本時間 3:00 / 11:00 / 19:00（8時間おき、1日3回）に
自動実行されます（UTCでは `0 2,10,18 * * *`）。間隔を変えたい場合は `cron` の値を編集してください。

手動実行やデバッグは `Actions` タブ → `FC27 Update Watch` → `Run workflow` から、
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
- SBC / EVO のタイトルにはゲームバージョン（`27` など）が含まれないことが多く、
  `APPLY_FC_VERSION_FILTER` が有効だとこれらの新着が通知から漏れる可能性があります。
  SBC/EVO はバージョンを問わず全件通知したい場合は、`fc26_watch/config.py` の該当
  `Source` を分けてフィルタを個別に無効化するか、ワークフローの環境変数で
  `APPLY_FC_VERSION_FILTER=false` を設定してください。
- `FC_VERSION_PATTERN`（`fc26_watch/config.py`）は現在 FC27 関連の新着のみを
  対象にしています。両サイトには過去作（FC26 等）の記事も残っているため、
  それらは自動的にフィルタで除外されます。次のタイトルが出た際はここを
  更新してください。
- スクレイピング元サイトの利用規約・robots.txt の範囲内でご利用ください。
- EA公式ニュース（`ea_official_news` ソース）のURL・リンクパターンは実サイトで検証できて
  いないベストエフォートの値です。`--dump-links` で実際のリンク構造を確認し、
  `fc26_watch/config.py` の該当 `Source` を調整してください。

## Discord コミュニティサーバー連携

`fc26_watch` に加えて、FC27 オンラインコミュニティ向けの Discord サーバーを
一括構築し、新着情報を Discord にも自動投稿する機能があります。

### サーバー構成

`fc26_watch/discord_structure.py` に定義されています。

- **雑談**: `クラブ雑談` / `グラウンズ雑談` / `アルティメット雑談` / `自己紹介`
- **お知らせ**（Bot 専用・一般メンバーは書き込み不可）:
  - `アップデート情報`（futbin/fut.ggの一般ニュース・パッチノート）
  - `EVO情報`（Evolutions）
  - `選手情報・SBC`（SBC / Objectives。いずれも選手カード獲得手段のため統合）
  - `EA公式情報`（EA公式サイトのFC27関連アップデート情報）
  - `トレンド`（X/旧Twitterで話題のFC27投稿トップ20を日本語で自動投稿。後述）
- **対戦・チームメイト募集**: `クラブ` / `グラウンズ` / `アルティメット`
  の3チャンネル（対戦相手募集・チームメイト募集・対象コンソールは、
  投稿の冒頭にタグを書いてもらう運用にし、チャンネルは分けていません）
- **ボイスチャンネル**: 案内用の `ボイスチャンネル案内`（テキスト）+ `ボイス1` 〜 `ボイス10`
  （Discord APIの制約でボイスチャンネル自体にはトピックを設定できないため、
  使い方の説明はこのテキストチャンネルに集約しています）

新着情報の分類は、futbin.com / fut.gg から実際に取得できる URL 構造
（`/evolutions/...` `/sbc/...` `/objectives/...` `/news/...`）を元に
`fc26_watch/fetcher.py` の `categorize_path` で機械的に判定しています
（EA公式ソースの記事は URL に関わらず常に `EA公式情報` に分類されます）。

### X（旧Twitter）トレンド機能について — 追加の準備が必要です

`トレンド` チャンネルへの自動投稿には、以下の外部APIが別途必要です。

- **X API Bearer Token**（`X_BEARER_TOKEN`）: [X Developer Portal](https://developer.x.com/)
  で取得します。**投稿の検索（recent search）には有料の「Basic」ティア以上が必要**で、
  無料の「Free」ティアでは検索APIが使えません（2026年時点で月額 $200 程度）。
  未設定の場合、トレンド投稿は自動的にスキップされます（エラーにはなりません）。
- **DeepL APIキー**（`DEEPL_API_KEY`、任意）: [DeepL API](https://www.deepl.com/ja/pro-api)
  の無料プランでも利用可能です。英語などの投稿を日本語に翻訳するために使います。
  未設定の場合、翻訳されずに原文のまま投稿されます。

Xの検索APIには月額コストが発生するため、実際に有効化するかどうかはご判断ください。
利用する場合は上記2つをリポジトリの Secrets に登録してください（登録方法は次項と同じ）。

各チャンネルには `fc26_watch/discord_structure.py` の `TOPICS` で定義した
説明文（チャンネルトピック）が設定され、初めて来た人でも各チャンネルの
使い方がわかるようになっています。

### セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) で
   アプリケーションと Bot を作成し、Bot トークンを発行。
   Bot 招待時には `Manage Channels`（チャンネル作成）
   `Send Messages` `Embed Links`（通知投稿）権限を付与してください。
2. このリポジトリの Secrets に `DISCORD_BOT_TOKEN` を登録。
3. `Actions` タブ → `FC27 Discord Server Setup` → `Run workflow` から、
   対象サーバーの Guild ID を入力して実行。
   カテゴリ・チャンネルを作成し（既存のものは重複作成せずスキップ）、
   お知らせ3チャンネルのIDを `discord_channels.json` に保存してリポジトリへ
   自動コミットします。
   `discord_structure.py` を編集してチャンネル構成を変えた場合も、この
   ワークフローを再実行すれば差分だけ反映されます。
   `wipe_existing` を ON にすると、実行前にサーバー内の**既存チャンネル・
   カテゴリを全て削除**してから構築します（メッセージ履歴も含め元に戻せない
   ので、他のBotの設定チャンネル等が残っていないか確認の上ご利用ください）。
4. 以降、`FC27 Update Watch` の定期実行時に、新着情報がメールに加えて
   該当する「お知らせ」チャンネルへ自動投稿されます
   （`DISCORD_BOT_TOKEN` 未設定時は Discord への投稿はスキップされます）。

### ローカルでの実行

```bash
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... python -m fc26_watch.discord_setup
```
