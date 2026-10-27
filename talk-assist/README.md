# 会話カンペ（英会話の返事を出してくれる PWA）

iPhone のマイクで相手の英語を聞き取って画面に出し、**そのまま読み上げれば会話が続く英語の返事・質問の候補**を表示するアプリです。
英語が話せなくても、候補を読むだけで会話ができることを目指しています。

- 音声認識：Soniox（リアルタイム、英語）
- 返事の候補と相手の発言の和訳：Claude（`claude-opus-5-5`、考える量 `low`）
- ホスティング：Cloudflare Workers（画面と API を1つの Worker で配信）

## 使い方

1. アプリの URL を Safari で開き、共有ボタンから「ホーム画面に追加」します。
2. 初回は ⚙️ 設定で**合言葉**を入れます。**自己紹介メモ**（名前、仕事、旅行の目的など）と**場面**を入れておくと、自分に合った返事が出ます。
3. 「▶ 開始」を押して、相手に話してもらいます。
4. 相手が話し終わると、英文（と和訳）の下に候補が4つほど出ます。好きなものを読み上げてください。
   - **候補を読み上げる**と、アプリが自分の発言だと判断して会話に記録し、相手の返事を待ちます。
   - **候補をタップ**しても記録できます。聞き取りがうまくいかないときに便利です。
   - 言いたいことがあるときは、下の欄に**日本語で入力して「英語に」**を押すと、その言い方が出ます。
   - 「🔄 別の候補」で作り直せます。
   - 候補にない英語を自分で話すときは「🙋 自分が話す」を押します。押している間の声は自分の発言になります。
5. 聞き分けを間違えたときは、会話の吹き出しをタップすると直せます（相手→自分に直す／自分の発言を消す）。
6. 5分間何も聞こえないと自動で停止します。🗒️ を押すと新しい会話を始められます。

> iPhone では、Safari が裏に回ったり画面がロックされたりするとマイクが止まります。会話中はアプリを開いたままにしてください（使用中は画面が消えないようにしています）。

## 構成

```
[iPhone Safari / PWA]  ── 同じオリジン ──  [Cloudflare Worker: talk-assist]
   │                                         ├─ web/ の静的ファイル(画面)
   │ ① POST /api/soniox-key                  ├─ Soniox の一時キーを発行(60秒・1回限り)
   │ ② WebSocket で音声を直接送る ─────────→ [Soniox stt-rt]
   │ ③ POST /api/suggest(会話の履歴)        └─ Claude に候補を作らせ、1行1候補で流す
   ▼
 相手の発言が終わる(Soniox の <end>)→ 自分の発言か判定 → 相手なら候補を作る
```

| パス | 内容 |
|---|---|
| `web/index.html`, `style.css`, `app.js` | 画面と処理（音声認識、発言の区切り、自分の発言の判定、候補の表示） |
| `web/manifest.json`, `sw.js`, `icons/` | PWA 用 |
| `worker/src/index.js` | Worker（画面の配信、Soniox の一時キー、Claude で候補を作る） |
| `worker/wrangler.toml` | Worker の設定。モデルなどはここの `[vars]` で変えられます |
| `../.github/workflows/deploy-talk-assist.yml` | デフォルトブランチへの push で自動デプロイ |

API キーはすべて Worker の Secret に入れ、ブラウザには渡しません。API は合言葉がないと使えず、画面と同じオリジンからの呼び出しだけを受け付けます。

## 必要な GitHub Secrets

リポジトリの **Settings → Secrets and variables → Actions** で登録します（ハヤメモと共通のものは登録済みです）。

| Secret 名 | 内容 | 状態 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude の API キー（https://platform.claude.com で作成） | **新しく登録が必要** |
| `SONIOX_API_KEY` | Soniox の API キー | ハヤメモで登録済みなら不要 |
| `APP_PASSPHRASE` | アプリで入力する合言葉 | ハヤメモと共通 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | ハヤメモと共通 |

## デプロイ

1. 上の Secret を登録します。
2. デフォルトブランチに `talk-assist/` の変更を push するか、**Actions → 「Deploy talk-assist (Cloudflare Worker)」→ Run workflow** を押します。
3. 完了すると、ジョブの Summary に**アプリの URL**（`https://talk-assist.<サブドメイン>.workers.dev`）が出ます。

## 調整できるところ

- `worker/wrangler.toml`
  - `CLAUDE_MODEL`：候補を作るモデル。速さを優先するなら `claude-haiku-5-5`
  - `CLAUDE_EFFORT`：考える量（`low` / `medium` / `high`）。上げると質は上がり、候補が出るまでの時間は長くなります
  - `SONIOX_MODEL`：音声認識のモデル
- 設定画面の「話し終わりの判定」：早くすると候補が早く出ますが、相手の話が途中で区切られやすくなります。
- `web/app.js` の先頭の定数：自動停止までの時間、自分の発言とみなす一致度など

## ローカルで動かす

```bash
cd talk-assist/worker
npm install
cp .dev.vars.example .dev.vars   # 値を入れる(コミットしない)
npx wrangler dev                 # http://localhost:8787
```

## 料金の目安

- Soniox：聞き取っている時間に応じて課金されます（ハヤメモと同じ単価で 1時間あたり約 $0.12）。
- Claude：相手が1回話すたびに1回呼び出します。会話の量やモデルで変わるので、Claude Console で使用量を確認してください。
