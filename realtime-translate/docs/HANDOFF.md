# 引き継ぎ書:リアルタイム英→日翻訳 字幕PWA

## 0. この文書について

- この文書は、Claude Code に実装を引き継ぐためのもの。
- アプリの詳細な仕様は **`SPEC.md`**(`realtime-translate-pwa-spec.md`)を参照すること。
- この文書には、**準備済みの内容・これからの作業・守るべきルール**をまとめる。

## 1. 作りたいもの(要約)

- iPhone Safari で動く PWA。英語の音声をリアルタイムに日本語へ翻訳し、**英語原文と日本語訳を2段で同時表示**する。
- 使用モデル:OpenAI **`gpt-realtime-translate`**(WebRTC 接続、英→日の1方向のみ、翻訳音声は再生しない)。
- **無音30秒で自動停止**(最後の英語文字起こし受信から30秒)。
- 料金:$0.034/分(1時間 約300円)。

## 2. 準備済みの内容

### OpenAI
- [x] OpenAI Platform アカウント作成済み
- [x] プロジェクト作成済み:**`realtime translation pwc`**
- [x] 上記プロジェクト内に API キー作成済み(権限:All)
- [x] プロジェクトの月間上限:**$10、ハードリミット有効**(上限到達で 429 エラーになる)
- [x] 利用額アラート設定済み
- 自動チャージはオンでも可(ハードリミットで上限は守られる)

### GitHub Secrets(オーナーが手動で登録する)
リポジトリの Settings → Secrets and variables → Actions に、以下を登録する(または登録済み)。

| Secret 名 | 内容 |
|---|---|
| `OPENAI_API_KEY` | OpenAI の API キー |
| `APP_PASSPHRASE` | アプリ利用時の合言葉 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン(「Edit Cloudflare Workers」テンプレート) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |

リポジトリがまだない場合は、最初にリポジトリを作成し、オーナーに Secrets の登録を依頼すること。

## 3. 絶対に守るルール(セキュリティ)

- **API キー・トークン・合言葉の値を、コード・設定ファイル・README・コミットに一切書かない。**
- **オーナーに API キーの値をチャットで尋ねない。** 値は GitHub Secrets にだけ存在する前提で実装する。
- `wrangler.toml` には Secret の値を書かない(名前の参照のみ)。
- ローカル開発用の `.dev.vars` などは必ず `.gitignore` に入れる。
- 標準の API キーはブラウザに渡さない。ブラウザには Worker が発行する**短時間有効の client secret** だけを渡す。
- Worker の CORS は GitHub Pages のオリジンのみ許可する。

## 4. 構成

```
[GitHub リポジトリ]
  ├─ フロント(静的 HTML/JS, manifest.json, Service Worker) → GitHub Pages で公開
  ├─ worker/(Cloudflare Worker: client secret 発行のみ)
  └─ .github/workflows/deploy-worker.yml(Worker 自動デプロイ)

[GitHub Actions] main への push で
  1. cloudflare/wrangler-action で Worker をデプロイ
  2. OPENAI_API_KEY と APP_PASSPHRASE を Worker Secret として登録
     (値は GitHub Secrets から渡す)
```

## 5. 作業タスク(この順番で進める)

1. **リポジトリ準備**
   - ディレクトリ構成を作成、`.gitignore` を整備
   - `SPEC.md` をリポジトリに配置
2. **Cloudflare Worker**
   - `POST /session`:合言葉を確認し、OpenAI の `/v1/realtime/translations/client_secrets` に出力言語 `ja` で問い合わせ、client secret を返す
   - CORS 設定(GitHub Pages のオリジンのみ)
3. **GitHub Actions**
   - main への push で Worker をデプロイし、Secret を登録するワークフロー
4. **フロント(MVP)**
   - 合言葉入力(localStorage に保存)
   - 開始 / 停止ボタン、WebRTC 接続
   - 英日2段表示(上段:英語、下段:日本語を大きく)、自動スクロール
   - 無音30秒で自動停止(残り10秒からカウントダウン表示)、最大90分で強制停止
   - Screen Wake Lock、状態表示、経過時間と概算料金の表示
   - PWA 化(ホーム画面に追加できる)
5. **GitHub Pages で公開**
6. **README 作成**:構成図、必要な Secrets の一覧と登録方法、Cloudflare の準備手順、使い方

## 6. 実装時の注意

- 実装前に、公式ガイドで最新の仕様を確認すること:
  https://developers.openai.com/api/docs/guides/realtime-translation
- 出力言語 `ja` がサポートされていることを、公式のモデルページで確認すること。
- 停止時は `RTCPeerConnection` の close とマイクトラックの `stop()` を必ず行い、課金が止まるようにする。
- 上限到達時は OpenAI から 429 エラー(`project_spend_limit_exceeded`)が返る。画面に「今月の利用上限に達しました」と分かりやすく表示する。
- オーナーは iPhone(Safari)で動作確認する。iOS 特有の制約(マイク許可、画面ロック時の挙動、自動再生制限)に注意する。

## 7. 完了の定義

- iPhone のホーム画面から起動し、YouTube の英語動画を流すと、英語原文と日本語訳が2段でリアルタイムに表示される。
- 30秒話さないと自動で停止し、OpenAI の Usage 画面で課金が止まっていることを確認できる。
- リポジトリのどこにも API キー等の値が含まれていない。
