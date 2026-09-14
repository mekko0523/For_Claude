# リアルタイムBot（`fc26_watch/realtime_bot`）のデプロイ

`fc26_watch` の残り（ニュースBot・サーバー構築）は GitHub Actions の定期実行だけで
動きますが、以下の4機能はDiscordからの通知（リアクション・新規参加・メッセージ）に
その場で反応する必要があるため、**常時起動し続けるプロセス**として別サーバーで動かします。

- リアクションロール（コンソール選択）
- ウェルカムメッセージ
- 簡易モデレーション（NGワード・スパム対策）
- レベル/XP

GitHub Actionsは「決まった時間に起動して終了する」仕組みのため、この用途には使えません。

## 1. Discord Developer Portal 側の設定

[Discord Developer Portal](https://discord.com/developers/applications) →
対象アプリケーション → `Bot` タブ

1. **Privileged Gateway Intents** で以下2つを ON にする（デフォルトOFF）
   - `SERVER MEMBERS INTENT`（ウェルカムメッセージに必要）
   - `MESSAGE CONTENT INTENT`（NGワード検知・XP集計に必要）
2. サーバー側で、Botのロールに以下の権限が付与されていることを確認
   - `Manage Roles`（リアクションロールの付与。**Botのロールが対象の6ロール
     （PS5/PS4/Switch/Switch2/Xbox/PC）より上に来るよう並び替えてください**）
   - `Manage Messages`（NGワード/スパムメッセージの削除）
   - `Moderate Members`（タイムアウト）
   - 既存の `Send Messages` `Manage Channels`（discord_setup.py 用）はそのまま

## 2. 必要な環境変数

| 変数名 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | ✓ | 既存のBotトークン（GitHub Secretsと同じ値） |
| `DISCORD_GUILD_ID` | ✓ | 対象サーバーのGuild ID |
| `BOT_STATE_FILE` | - | XP/警告データの保存先（Docker利用時は自動設定済み） |
| `BOT_WELCOME_CHANNEL` | - | ウェルカムメッセージの投稿先チャンネル名（デフォルト: `自己紹介`） |
| `BOT_REACTION_ROLE_CHANNEL` | - | リアクションロールメッセージの投稿先（デフォルト: `自己紹介`） |
| `BOT_NG_WORDS` | - | NGワードをカンマ区切りで指定（デフォルトの簡易リストを丸ごと置き換え） |
| `BOT_NG_WORDS_EXTRA` | - | デフォルトのNGワードに追加したい単語（カンマ区切り） |
| `BOT_SPAM_MESSAGE_LIMIT` / `BOT_SPAM_INTERVAL_SECONDS` | - | 何秒間に何通でスパム判定するか（デフォルト: 7秒に6通目以降） |
| `BOT_WARN_LIMIT` / `BOT_TIMEOUT_SECONDS` | - | 何回警告でタイムアウトするか／タイムアウト秒数（デフォルト: 3回・300秒） |
| `BOT_XP_MIN` / `BOT_XP_MAX` / `BOT_XP_COOLDOWN_SECONDS` | - | 1メッセージあたりのXP範囲とクールダウン秒数 |

## 3. デプロイ先（いずれか）

このリポジトリには `Dockerfile` と `Procfile` を用意しています。

### Railway / Render（推奨・手軽）

1. GitHubリポジトリを接続し、新規サービスを作成（Renderは `Background Worker` を選択）
2. 上記の環境変数を登録
3. **永続ボリュームを追加**し、`/app/data` にマウント（XP/警告データを保持するため。
   付け忘れるとデプロイのたびにレベルがリセットされます）
4. デプロイ実行（`Dockerfile` を自動検出して起動します）

### Fly.io

```bash
fly launch --no-deploy   # Dockerfileを検出
fly volumes create data --size 1
# fly.toml の [mounts] に source="data", destination="/app/data" を追記
fly secrets set DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=...
fly deploy
```

### 自前のVPS

```bash
docker build -t fc26-realtime-bot .
docker run -d --restart unless-stopped \
  -e DISCORD_BOT_TOKEN=... -e DISCORD_GUILD_ID=... \
  -v $(pwd)/data:/app/data \
  fc26-realtime-bot
```

## 4. 動作確認

起動ログに `Logged in as <Botの名前>` と出れば接続成功です。設定した
`BOT_REACTION_ROLE_CHANNEL`（デフォルト `自己紹介`）にリアクションロールの
案内メッセージが自動投稿されます（初回起動時のみ。以降は既存メッセージを
再利用し、二重投稿しません）。

## 5. 注意点

- ニュースBot（`fc26-watch.yml`）・サーバー構築（`discord-setup.yml`）とは
  完全に独立したプロセスです。同じBotトークンを使い回して問題ありません
  （GitHub Actions側はREST APIの単発呼び出しのみで、常時接続はこちらの
  プロセスだけが持ちます）。
- NGワードのデフォルトリストは最小限のプレースホルダーです。運用前に
  `BOT_NG_WORDS` / `BOT_NG_WORDS_EXTRA` で実際に使うリストへ調整してください。
- XP/警告データはJSONファイル1つに保存する簡易実装です。永続ボリュームを
  付けていないホストでは再起動のたびにリセットされる点にご注意ください。
