# ハヤメモ(英→日 リアルタイム翻訳・日本語文字起こし PWA)

iPhone のマイクで拾った英語を、OpenAI `gpt-realtime-translate` でリアルタイムに日本語へ翻訳し、
**英語原文(上段)と日本語訳(下段)を同時に表示**する PWA です。翻訳音声は再生せず、字幕のみ表示します。

- 料金:$0.034/分(1時間 約300円)。OpenAI プロジェクトの月間上限 $10(ハードリミット)で止まります。
- **無音3分で自動停止**(最後に英語の文字起こしが届いてから30秒)。1セッション最大90分。
- 公開 URL:`https://mekko0523.github.io/For_Claude/`

## 構成

```
[GitHub リポジトリ mekko0523/For_Claude]
  ├─ realtime-translate/web/     フロント(HTML/JS, manifest.json, Service Worker)→ GitHub Pages
  ├─ realtime-translate/worker/  Cloudflare Worker(client secret 発行のみ)
  └─ .github/workflows/deploy-worker.yml
        デフォルトブランチへの push(realtime-translate/ 配下の変更)で
          1. cloudflare/wrangler-action で Worker をデプロイ
          2. OPENAI_API_KEY / APP_PASSPHRASE を Worker Secret として登録(値は GitHub Secrets から)
          3. Worker の URL を config.js に書き込み、web/ を GitHub Pages に公開

[実行時]
[iPhone Safari / PWA]
   │ ① POST /session { passphrase }            (CORS: https://mekko0523.github.io のみ許可)
   ▼
[Cloudflare Worker] ── ② POST /v1/realtime/translations/client_secrets
   │                     (model: gpt-realtime-translate, 出力 ja, 英語文字起こし: gpt-realtime-whisper)
   ▼
[OpenAI] → 短時間有効な client secret を返す(標準 API キーはブラウザに渡らない)
   │
[iPhone] ③ WebRTC で /v1/realtime/translations/calls に接続、マイク音声を送信
         データチャネル oai-events で字幕イベントを受信
           session.input_transcript.delta  → 上段(英語)
           session.output_transcript.delta → 下段(日本語)
```

| パス | 内容 |
|---|---|
| `web/index.html`, `style.css`, `app.js` | 画面と接続ロジック |
| `web/config.js` | Worker の URL(**Actions がデプロイ時に自動生成**。リポジトリ内のものはダミー) |
| `web/manifest.json`, `sw.js`, `icons/` | PWA 用 |
| `worker/src/index.js`, `worker/wrangler.toml` | client secret 発行 Worker |
| `worker/.dev.vars.example` | ローカル開発用 Secret のひな形(`.dev.vars` は `.gitignore` 済み) |
| `docs/HANDOFF.md` | 引き継ぎ書 |

## 必要な GitHub Secrets

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で登録します。
値はここ以外(コード・README・チャット)には書かないでください。

| Secret 名 | 内容 |
|---|---|
| `OPENAI_API_KEY` | OpenAI の API キー(プロジェクト `realtime translation pwc` のもの) |
| `APP_PASSPHRASE` | アプリで入力する合言葉(自由に決める) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン(テンプレート「Edit Cloudflare Workers」) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |

未登録の Secret があるとワークフローは最初のステップで「GitHub Secret 'XXX' が未登録です」と表示して止まります。

## 初回セットアップ手順

### 1. Cloudflare の準備

1. https://dash.cloudflare.com でアカウントを作成(無料プランで可)。
2. 左メニュー **Workers & Pages** を一度開き、`*.workers.dev` のサブドメインを決める(初回のみ聞かれます)。
3. **アカウント ID**:Workers & Pages の画面右側(または アカウントのホーム → ⋯ → Copy account ID)からコピー
   → `CLOUDFLARE_ACCOUNT_ID` に登録。
4. **API トークン**:右上のアイコン → My Profile → **API Tokens → Create Token →
   「Edit Cloudflare Workers」テンプレート → Use template**。
   Account Resources は自分のアカウント、Zone Resources は「All zones」のままで可 → 作成してコピー
   → `CLOUDFLARE_API_TOKEN` に登録。

### 2. GitHub の準備

1. 上の表の4つの Secret を登録。
2. **Settings → Pages → Build and deployment → Source を「GitHub Actions」** にする。
3. **Actions タブ → 「Deploy realtime-translate (Worker + GitHub Pages)」→ Run workflow**
   (またはデフォルトブランチに `realtime-translate/` の変更を push)。
4. 完了後、`worker` ジョブのログ「Resolve Worker URL」に Worker の URL が出ます。
   `pages` ジョブの URL(`https://mekko0523.github.io/For_Claude/`)がアプリです。

動作確認(任意。合言葉はシェル履歴に残るので、確認後は履歴を消すか省略してください):

```bash
curl -X POST https://realtime-translate-session.<サブドメイン>.workers.dev/session \
  -H "Origin: https://mekko0523.github.io" -H "Content-Type: application/json" \
  -d '{"passphrase":"<合言葉>"}'
# => {"value":"ek_...","expires_at":...}
```

### ローカル開発(任意)

```bash
cd realtime-translate/worker
cp .dev.vars.example .dev.vars   # 値を入れる(コミットされない)
npx wrangler dev
```

## 使い方(iPhone)

1. Safari で `https://mekko0523.github.io/For_Claude/` を開き、共有 → **ホーム画面に追加**。
2. ホーム画面から起動し、⚙︎ で合言葉を入力(端末の localStorage に保存)。
3. 「開始」→ マイクを許可 → 英語が聞こえると上段に英語、下段に日本語が流れます。
4. 終わったら「停止」。押し忘れても無音3分で自動停止します(残り10秒からカウントダウン表示)。

その他の機能:経過時間と概算料金の表示、Screen Wake Lock(翻訳中は画面が消えない)、
文字サイズ変更、ダークモード、字幕のテキスト保存(⚙︎ → 字幕を保存)。

調整用の定数は `web/app.js` 冒頭にあります。

```js
const SILENCE_TIMEOUT_MS = 30_000;   // 無音で停止するまでの時間
const COUNTDOWN_SHOW_MS  = 10_000;   // カウントダウン表示を始める残り時間
const MAX_SESSION_MS     = 90 * 60_000;
```

## 注意

- 停止時(手動・自動とも)は `RTCPeerConnection.close()` とマイクトラックの `stop()` を行い、課金を止めます。
  実際に止まったかは OpenAI の Usage 画面で確認してください。
- 月間上限に達すると OpenAI が 429(`project_spend_limit_exceeded`)を返し、画面に
  「今月の利用上限に達しました」と表示されます。
- 自動停止は「英語の文字起こしが届いたか」で判定します。BGM や雑音だけでは延長されませんが、
  英語の歌詞やテレビ音声は会話とみなされます。
- 画面ロックやアプリ切替で iOS がマイクを止めることがあります。その場合は無音扱いで自動停止します。
  **同じ iPhone で YouTube を再生すると、マイク使用中は再生が止まる/音が小さくなることがあります。**
  動画は PC や別の端末のスピーカーで流すのが確実です。
- ノイズ除去は離れたスピーカーの音向け(`far_field`)にしています。口元で話す用途なら
  `worker/wrangler.toml` の `NOISE_REDUCTION` を `near_field` に変更してください。

## 集音ブーストと用語集(⚙︎ 設定)

- **集音ブースト**:マイクの音をアプリ内で増幅(×3 / ×6)し、コンプレッサーで音割れを防いでから送ります。
  既定は「標準(×3)」。iOS でブースト経路が無音になった場合は、6秒後に自動で生のマイクへ切り替えます。
- **用語集**:1行に「誤り → 正しい」を書くと、字幕の表示と保存テキストで自動的に置き換えます
  (英数字は大文字小文字を区別せず単語単位)。`gpt-realtime-translate` のセッションには用語や指示を渡す
  設定がないため(設定できるのは noise_reduction / transcription.model / output.language のみ)、
  アプリ側での置き換えで対応しています。

## 要約メモ(保存・共有)

- 「保存・共有」→「📝 要約メモを作成」で、字幕(英語原文+日本語訳+用語集)から日本語の要約メモ
  (概要・要点・決定事項・アクション・数値/固有名詞)を作ります。内容は編集でき、自動保存されます。
- 「要約メモを共有」はテキストとして iOS の共有シートに渡します(LINE・メール・メモなどに貼れる)。
- Worker の `POST /summary` が OpenAI Responses API を呼びます(モデルは `wrangler.toml` の
  `SUMMARY_MODEL`、既定 `gpt-6.1-sol`、`store: false`)。料金は同じ OpenAI プロジェクトの上限内で課金されます。

## 話者分け(要約メモ)

- 翻訳中の音声を端末内(IndexedDB)に録音します(⚙︎ で オン/オフ。32kbps・20分ごとに分割・14日で自動削除)。
- 要約時に「話者を分けて要約する」をオンにすると、録音を Worker の `POST /diarize` 経由で
  OpenAI `gpt-4o-transcribe-diarize`(`response_format=diarized_json`)に送り、「話者A/B…: 発言」の書き起こしを作って
  要約に渡します。要約には「■ 参加者」が加わり、発言・アクションの担当が話者ごとに書かれます。
- 話者ラベルは声の違いから自動推定したもので、名前は会話中に出た場合のみ推測されます。
  識別結果はセッションに保存され、要約を作り直しても再送信しません。全文ファイルにも含まれます。

## 日本語の文字起こしモード

- 画面上部の切り替えで「🌐 英→日 翻訳」と「🎙 日本語 文字起こし」を選べます(切り替えると新しいセッション)。
- 文字起こしは OpenAI Realtime の transcription セッション(`/v1/realtime/client_secrets` → WebRTC `/v1/realtime/calls`)。
  モデルは `gpt-live-transcribe`(`languages: ["ja"]`・`delay: "low"`・分野の説明 `prompt`・用語集から作る `keywords`)。
  受け付けられない場合は Worker が自動で `gpt-transcribe` の最小構成に切り替えます(`TRANSCRIBE_MODEL` で変更可)。
- ターン検出は使わず、発話が1.5秒途切れたら(最長15秒ごとに)アプリが `input_audio_buffer.commit` を送って確定させます。
- 要約メモ・話者分け・保存・履歴・用語集の置き換えは翻訳モードと共通。要約は日本語の議事メモ形式
  (概要・要点・決定事項・アクション・課題/確認事項・数値/固有名詞)。
- 用語集で矢印なしの単語だけの行は、文字起こしのキーワードとして使われます。
- 区切り(`input_audio_buffer.commit`)は WebRTC 統計の送信音量を使ったクライアント側 VAD で判定します
  (話し声のあと0.9秒静かなら区切る。雑音レベルは自動で学習。30秒を超えたら次の小さな間、45秒で必ず区切る)。
- ⚙︎「日本語 文字起こしの優先」で `delay` を選べます(速さ優先=low / バランス=medium〔既定〕/ 精度優先=high)。

## 清書

- 「保存・共有」→「✨ 清書する」で、端末の録音を Worker の `POST /clean` 経由で OpenAI `gpt-transcribe`
  (録音ファイル用。`languages`・`keywords`・分野の `prompt` 付き。受け付けられない場合は簡易設定→`gpt-4o-transcribe` に自動切替)
  に送り、高精度に文字起こしし直します。
- 翻訳モードでは清書した英語を `POST /translate`(`SUMMARY_MODEL`)で日本語に訳し直します。
- 清書後は画面が「清書版」になり(リアルタイム版と切り替え可)、要約メモと保存ファイルも清書版を使います。
  「再開」すると続きはリアルタイム版に追記されます。

## 用語集(画面下の「用語集」ボタン)

- 「言い換え(誤り → 正しい)」と「キーワード」を一覧で追加・削除できます(テキストでまとめて編集も可)。
- 言い換えは表示・清書・要約・保存ファイルに適用。キーワード(と言い換えの正しい側)は日本語の文字起こしと清書でモデルに渡します。
