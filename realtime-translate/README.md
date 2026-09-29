# 英日リアルタイム字幕 PWA

iPhone のマイクで拾った英語を、OpenAI `gpt-realtime-translate` でリアルタイムに日本語へ翻訳し、
**英語原文(上段)と日本語訳(下段)を同時に表示**する PWA です。翻訳音声は再生せず、字幕のみ表示します。

## 構成

```
[iPhone Safari / PWA]  (GitHub Pages: realtime-translate/web)
   │ ① POST /session  { passphrase }
   ▼
[Cloudflare Worker]    (realtime-translate/worker)  ← OPENAI_API_KEY / PASSPHRASE は Secret
   │ ② POST https://api.openai.com/v1/realtime/translations/client_secrets
   ▼
[OpenAI] → 短時間有効な client secret(value)を返す
   │
[iPhone] ③ WebRTC で https://api.openai.com/v1/realtime/translations/calls に接続
         マイク音声を送信 → データチャネル oai-events で字幕イベントを受信
           session.input_transcript.delta  → 上段(英語)
           session.output_transcript.delta → 下段(日本語)
```

| パス | 内容 |
|---|---|
| `web/index.html`, `style.css`, `app.js` | 画面と接続ロジック |
| `web/config.js` | Worker の URL(**デプロイ後に書き換える**) |
| `web/manifest.json`, `sw.js`, `icons/` | PWA 用 |
| `worker/src/index.js`, `worker/wrangler.toml` | client secret 発行 Worker |
| `../.github/workflows/translate-pages.yml` | `web/` を GitHub Pages に公開 |

## 主な機能

- 開始 / 停止ボタン、状態表示(待機中 / 接続中 / 翻訳中 / 自動停止 / エラー)
- 経過時間と概算料金(経過分 × $0.034)
- **無音30秒で自動停止**:最後に英語の文字起こし(`session.input_transcript.delta`)が届いてから30秒で停止。
  開始直後は接続完了時点から数える。残り10秒でカウントダウン表示。停止時は PeerConnection を close、
  マイクの全トラックを stop、Wake Lock を解除。字幕は残る。
- 1セッション最大90分で強制停止
- 翻訳中は Screen Wake Lock で画面スリープを防止
- 文字サイズ変更、ダークモード(端末設定に追従)、字幕のテキスト保存(時刻付き英日ログ)

調整用の定数は `web/app.js` 冒頭にまとめてあります。

```js
const SILENCE_TIMEOUT_MS = 30_000;   // 無音で停止するまでの時間
const COUNTDOWN_SHOW_MS  = 10_000;   // カウントダウン表示を始める残り時間
const MAX_SESSION_MS     = 90 * 60_000;
const PARAGRAPH_GAP_MS   = 1_500;    // 字幕の改段落間隔
```

## セットアップ

### 1. OpenAI の API キーと利用上限

1. https://platform.openai.com/api-keys で API キーを発行(このキーはブラウザに置かない)。
2. **Settings → Limits(Billing)で月の利用上限(Spend limit)を設定**(例:$7 ≒ 1,000円)。
3. 実装前チェック:モデルページ / ガイドで、出力言語 `ja`(日本語)がサポートされていることを確認。
   公式ガイドのサンプルは `es` のみで、本 README 作成時点では対応言語一覧を確認できていません。
   - https://developers.openai.com/api/docs/guides/realtime-translation
   - https://developers.openai.com/api/docs/models/gpt-realtime-translate

### 2. Cloudflare Worker をデプロイ

```bash
cd realtime-translate/worker
npx wrangler login
# wrangler.toml の ALLOWED_ORIGIN を GitHub Pages のオリジンに合わせる
#   例: https://mekko0523.github.io (パス /for_claude/ は含めない)
npx wrangler secret put OPENAI_API_KEY   # sk-... を貼り付け
npx wrangler secret put PASSPHRASE       # 任意の合言葉
npx wrangler deploy
```

表示された URL(`https://realtime-translate-session.<subdomain>.workers.dev`)を控えます。

動作確認:

```bash
curl -X POST https://realtime-translate-session.<subdomain>.workers.dev/session \
  -H "Origin: https://mekko0523.github.io" -H "Content-Type: application/json" \
  -d '{"passphrase":"<合言葉>"}'
# => {"value":"ek_...","expires_at":...}
```

### 3. フロントを GitHub Pages に公開

1. `web/config.js` の `WORKER_URL` を手順2の URL に書き換えてコミット・push。
2. リポジトリの **Settings → Pages → Build and deployment → Source を「GitHub Actions」** にする。
   (非公開リポジトリで Pages を使うには有料プランが必要です。公開したくない場合は PWA 用の別の公開リポジトリに
   `web/` の中身をコピーしてください)
3. `web/` を変更して push するか、Actions タブから「Deploy translate PWA to GitHub Pages」を手動実行。
4. `https://mekko0523.github.io/for_claude/` で開けます。

### 4. iPhone で使う

1. Safari で上記 URL を開き、共有 → **ホーム画面に追加**。
2. ホーム画面から起動し、⚙︎ で合言葉を入力(端末の localStorage に保存)。
3. 「開始」→ マイクを許可 → 英語が聞こえると上段に英語、下段に日本語が流れます。
4. 終わったら「停止」。押し忘れても無音30秒で自動停止します。

## 注意

- 料金は **入力音声の長さ** で課金されます($0.034/分 ≒ 1時間約300円)。画面の料金は目安です。
  停止後に課金が止まっているかは OpenAI の Usage 画面で確認してください。
- 自動停止は「英語の文字起こしが届いたか」で判定するため、BGM や雑音だけでは延長されませんが、
  英語の歌詞やテレビ音声などは会話とみなされます。
- 画面ロックやアプリ切替時、iOS はマイクを止めることがあります。その場合は無音扱いで自動停止します。
- `web/` のファイルを更新したら、PWA のキャッシュ更新のため `sw.js` の `CACHE` 名を上げると確実です
  (Service Worker はネットワーク優先なので、通常はそのままでも反映されます)。

## テスト観点(仕様書 §6)

- 翻訳精度、固有名詞・数字・日付・金額、専門用語(農業・農薬・ドローン)
- 早口・訛り・複数人の同時発話
- 最初の字幕までの遅延、英日表示タイミングのずれ(YouTube の英語動画で Kotoba と比較)
- 無音30秒自動停止:正しく止まるか / 停止後に課金が止まるか / 会話中に誤停止しないか
- 画面ロック・バックグラウンド移行時の挙動、外部マイク使用時の精度
