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
- **お知らせ**:
  - `アップデート情報`（futbin/fut.ggの一般ニュース・パッチノート。Bot専用・書き込み不可）
  - `EVO情報`（Evolutions。Bot専用・書き込み不可）
  - `選手情報・SBC`（SBC / Objectives。いずれも選手カード獲得手段のため統合。Bot専用・書き込み不可）
  - `EA公式情報`（EA公式サイトのFC27関連アップデート情報。Bot専用・書き込み不可）
  - `トレンド`（X/旧Twitter等で話題のFC27投稿を**運営が手動で**ピックアップして共有する
    チャンネル。他と異なりBot専用ではなく、通常のメンバーも書き込み可能です）
  - `運営への報告`（荒らし・迷惑行為・トラブル等を運営に伝えるための通報用チャンネル。
    当初はボイスチャンネルカテゴリにありましたが、お知らせに移動しました）
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

### トレンドチャンネルについて

Xの投稿検索APIは無料ティアでは利用できず、検索可能な最安プランでも月額$200程度かかるため、
自動化はせず**運営メンバーが手動で投稿する運用**にしています。`トレンド` チャンネルだけは
Bot専用の書き込み制限を外してあるので、話題の投稿のリンクなどを直接貼って共有してください。

### ニュースの日本語翻訳について（任意）

`アップデート情報` `EVO情報` `選手情報・SBC` `EA公式情報` に自動投稿されるニュースの
タイトルは、[DeepL API](https://www.deepl.com/ja/pro-api)キー（`DEEPL_API_KEY`）を
Secretsに登録すると日本語に自動翻訳されます（無料プランで利用可能）。**リンク自体は
常に原文記事のURLのまま**です。未設定の場合は原文タイトルのまま投稿されます。

各チャンネルには `fc26_watch/discord_structure.py` の `TOPICS` で定義した
説明文（チャンネルトピック）が設定され、初めて来た人でも各チャンネルの
使い方がわかるようになっています。

`ボイスチャンネル案内` と `運営への報告`、および雑談（`クラブ雑談`/`グラウンズ雑談`/
`アルティメット雑談`/`自己紹介`）とお知らせ（`アップデート情報`/`EVO情報`/
`選手情報・SBC`/`EA公式情報`/`トレンド`）の各チャンネルは、トピック（短い説明）に
加えて、使い方をまとめた詳しいメッセージ本文を `fc26_watch/announce.py` から
投稿できます（`FC27 Discord Server Setup` ワークフローの `post_voice_guide` /
`post_report_guide` / `post_channel_guides`（雑談・お知らせ分をまとめて投稿）を
ON にして実行、またはローカルで
`DISCORD_BOT_TOKEN=... python -m fc26_watch.announce <voice_guide|report_guide|channel_guides>`）。

### コンソールロール（PS5/PS4/Switch/Switch2/Xbox/PC）

`fc26_watch/discord_structure.py` の `CONSOLE_ROLES` で6つのロールを定義しており、
`FC27 Discord Server Setup` ワークフロー実行時に自動作成されます（既存ロールがあれば
スキップ、`discord_roles.json` にロールIDを保存）。それぞれ固有の色とアイコン（絵文字）を
持ち、メンバーリストでも別グループとして表示されます（`hoist`設定）。

- ロールを自分に付けたメンバーは、**投稿するメッセージのユーザー名がそのロールの色になる**
  ため、どのコンソールを使っているか一目でわかります。
- サーバーのブーストレベルが対応していれば、メンバーリスト・プロフィールにロールの
  絵文字アイコンも表示されます（対応していない場合は色分けのみになります）。
- 色だけだと見落としやすいため、`hourly_bot.py`（下記）がリアクションに合わせて
  **サーバーニックネームに `[PS5]` のようなタグを自動で付与**します。投稿者本人にも
  見ている人にも、メッセージのたびに使用コンソールがひと目でわかります
  （複数選択時は `[PS5/PC]` のように併記。リアクションを外すとロールとタグの両方が
  自動で外れます）。

**新規参加者に選んでもらう画面について**: Discordの「オンボーディング」機能
（Server Settings > Onboarding）を使うのがもっとも安全・確実です。サーバーの検証レベルや
公開設定に関わる変更を伴うため、意図しない副作用を避ける目的でAPIからの自動設定はせず、
手動セットアップの手順を案内する形にしています（下記チャットの案内を参照）。ロール自体は
既に作成済みなので、オンボーディングの「ロール選択」プロンプトに紐づけるだけで完了します。

### リアクションロール・ウェルカムメッセージ・簡易モデレーション・レベルXP

以下4機能を実装しています（当初MEE6での運用を検討しましたが、これらの
プラグインが有料プラン限定だったため、自前実装に切り替えました）。

- **リアクションロール**: `自己紹介` チャンネル（変更可）にコンソール選択メッセージを
  自動投稿し、リアクションで `PS5`/`PS4`/`Switch`/`Switch2`/`Xbox`/`PC` ロールの
  付与・解除を行います。あわせてサーバーニックネームに `[PS5]` のようなタグを自動で
  付与するので、投稿のたびに使用コンソールが誰の目にもわかります。
- **ウェルカムメッセージ**: 新規メンバー参加時に自動で挨拶メッセージを投稿します。
- **簡易モデレーション**: NGワードを含む投稿・短時間の連続投稿（スパム）を自動削除し、
  警告を重ねると自動タイムアウトします。
- **レベル/XP**: メッセージ投稿ごとにXPを付与し、レベルアップ時に通知します。

SNS通知機能（MEE6のSocialプラグイン相当）は、ご要望により実装していません。

現在は **`fc26_watch/hourly_bot.py`（REST APIのみ・1時間ごとの定期実行）** で
運用します。`.github/workflows/discord-hourly-bot.yml` により、他のワークフロー
同様GitHub Actionsだけで動きます（追加のサーバー契約は不要）。ただし常時接続では
ないため、どの機能も**反応が最大で約1時間遅れます**（新規参加から挨拶まで、
リアクションしてからロール付与まで、NGワード投稿から削除までなど）。少人数の
コミュニティ運営を想定した割り切りです。

将来、常時接続でリアルタイムに反応させたくなった場合のために、同じ4機能を
常時起動プロセスとして実装した `fc26_watch/realtime_bot/`（fly.io等へのデプロイ
用、`Dockerfile`/`Procfile`/[DEPLOY.md](./DEPLOY.md)）も残してあります。現時点では
未デプロイ・未使用です。両実装は `fc26_watch/realtime_bot/config.py` のチューニング
項目（NGワード・XP倍率など）を共有しているので、乗り換える際も環境変数はそのまま
使えます。

#### hourly_bot のセットアップ

1. Discord Developer Portal → 対象アプリ → `Bot` タブ → **Privileged Gateway
   Intents** の `SERVER MEMBERS INTENT` をON（新規参加者を検知するために必要。
   常時接続はしないのでトグルのみでOKです）
2. サーバー側で、Botのロールに以下の権限を追加（既存の `Send Messages`
   `Manage Channels` に加えて）
   - `Manage Roles`（リアクションロールの付与。**Botのロールを対象の6ロール
     （PS5/PS4/Switch/Switch2/Xbox/PC）より上に並び替えてください**）
   - `Manage Nicknames`（コンソールタグをニックネームに付与。同様にBotのロールが
     対象メンバーより上にある必要があります。サーバーオーナーはDiscordの仕様上、
     Botからは変更できません）
   - `Manage Messages`（NGワード/スパムメッセージの削除）
   - `Moderate Members`（タイムアウト）
3. リポジトリの Secrets に `DISCORD_GUILD_ID`（対象サーバーのGuild ID）を追加
   登録（`DISCORD_BOT_TOKEN` は既存のものをそのまま使います）
4. `Actions` タブ → `FC27 Discord Community Bot (Hourly)` → `Run workflow` で
   手動実行して動作確認（以降は毎時0分に自動実行され、`hourly_bot_state.json`
   がリポジトリへ自動コミットされます）

NGワードのデフォルトは最小限のプレースホルダーです。`BOT_NG_WORDS` /
`BOT_NG_WORDS_EXTRA` 環境変数（ワークフローの `env:` に追加）で実際に使う
リストに調整してください（`fc26_watch/realtime_bot/config.py` 参照）。

### セキュリティ監査（サーバーオーナー以外が荒らせないかのチェック）

`fc26_watch/security_audit.py` は、サーバーオーナー以外のロール・チャンネル権限に、
サーバーを乗っ取ったり荒らしたりできてしまう危険な権限（`Administrator` /
`Manage Server` / `Manage Roles` / `Manage Channels` / `Manage Webhooks` /
`Kick`・`Ban` / 他人のメッセージを消せる `Manage Messages` / `@everyone`への
メンション等）が付いていないかを確認する読み取り専用の診断ツールです。**何も変更せず、
レポートを表示するだけ**です。

`Actions` タブ → `FC27 Discord Security Audit` → `Run workflow` で実行し、実行結果
（Actionsのログ）を確認してください。問題が見つかった場合の対処（該当ロールから権限を
外す等）は自動では行わないため、レポートを見てDiscord側で個別に対応してください。

あわせて以下も手動で確認することを推奨します（Botの権限だけでは確認できないため）。
- Server Settings > Invites: 期限・使用回数無制限の招待リンクで身に覚えのないものは削除
- Server Settings > Safety Setup > 認証レベル: `None`/`Low`だと新規・未認証アカウントが
  すぐ参加・投稿できてしまうため、荒らし被害があれば`Medium`以上への引き上げを検討
- Server Settings > Safety Setup > 監査ログ: 不審な操作履歴がないか

### セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) で
   アプリケーションと Bot を作成し、Bot トークンを発行。
   Bot 招待時には `Manage Channels`（チャンネル作成）
   `Send Messages` `Embed Links`（通知投稿）権限を付与してください。
2. このリポジトリの Secrets に `DISCORD_BOT_TOKEN` を登録。
3. `Actions` タブ → `FC27 Discord Server Setup` → `Run workflow` から、
   対象サーバーの Guild ID を入力して実行。
   カテゴリ・チャンネルを作成し（既存のものは重複作成せずスキップ）、
   お知らせチャンネルのIDを `discord_channels.json` に保存してリポジトリへ
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
