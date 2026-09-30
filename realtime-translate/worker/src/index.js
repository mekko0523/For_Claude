// client secret を発行するだけの Cloudflare Worker。
// OPENAI_API_KEY は Worker Secret にのみ保存し、ブラウザには短時間有効な client secret だけを返す。
// Secret(値は GitHub Secrets → Actions 経由で登録。ここには書かない):
//   OPENAI_API_KEY, APP_PASSPHRASE

const OPENAI_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
const MODEL = "gpt-realtime-translate";
// 英語原文の文字起こし(session.input_transcript.delta)に必要
const INPUT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
// 要約メモ(/summary)
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_SUMMARY_MODEL = "gpt-6.1-sol";
const SUMMARY_MAX_CHARS = 200_000; // 英日+話者付き書き起こしの入力上限(約2時間分)
// 話者分け(/diarize): 録音ファイルから「誰が話したか」付きの書き起こしを作る
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_DIARIZE_MODEL = "gpt-4o-transcribe-diarize";
const DIARIZE_MAX_BYTES = 25 * 1024 * 1024; // OpenAI のファイル上限
const SUMMARY_INSTRUCTIONS = `あなたは農業・農薬分野に詳しい日本語の議事録担当です。
英語の会話(英語原文と、その機械翻訳の日本語訳)から、共有用の簡潔な要約メモを日本語だけで作成してください。

出力形式(プレーンテキスト。Markdown の記号 # * は使わない):
■ 概要
2〜4文で、何の話だったか。
■ 要点
・重要なポイントを箇条書きで3〜8個
■ 決定事項
・決まったこと(なければ「特になし」)
■ アクション
・誰が/何を/いつまでに(不明な部分は「(担当未定)」「(期限未定)」と書く。なければ「特になし」)
■ 数値・固有名詞メモ
・製品名、農薬名、成分名、数量、金額、日付など、正確さが大事なもの(なければ省略)

ルール:
- 英語原文を正として内容を確認し、日本語訳の誤訳はあなたの判断で直す
- 用語集が与えられた場合はその表記に従う
- 話されていないことを推測で足さない。聞き取れていない部分は無理に埋めない
- 全体で600字程度まで

【話者付き書き起こし】が与えられた場合(話者ラベルは音声から自動識別したもの):
- 先頭に「■ 参加者」を追加し、話者ごとに立場や役割が分かれば1行で書く(例: 話者A:農薬メーカーの担当者らしい)
- 会話中に名前が出ていれば、話者ラベルの代わりに名前を使う(確証がなければ「話者A(田中さん?)」のように書く)
- 要点・決定事項・アクションは「誰の発言・誰の担当か」を明記する
- 録音が複数に分かれている場合、同じ人に別ラベルが付くことがあるので、内容から同一人物と判断できればまとめる
- この場合は全体で900字程度まで`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);
    const originOk = allowed.includes(origin);
    const cors = originOk ? corsHeaders(origin) : {};

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    }

    if (!["/session", "/summary", "/diarize"].includes(url.pathname)) {
      return json({ error: "not_found" }, 404, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }
    if (!originOk) {
      return json({ error: "forbidden_origin" }, 403, cors);
    }
    if (!env.OPENAI_API_KEY || !env.APP_PASSPHRASE) {
      return json({ error: "server_not_configured" }, 500, cors);
    }

    // 録音ファイルは本文が音声なので、合言葉はヘッダーで受け取る
    if (url.pathname === "/diarize") return diarize(request, env, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400, cors);
    }

    const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
    if (!(await safeEqual(passphrase, env.APP_PASSPHRASE))) {
      return json({ error: "invalid_passphrase" }, 401, cors);
    }

    if (url.pathname === "/summary") return summarize(body, env, cors);

    const upstream = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        // 合言葉のハッシュを利用者 ID として送る(生の値は送らない)
        "OpenAI-Safety-Identifier": await sha256Hex(`rt-translate:${env.APP_PASSPHRASE}`),
      },
      body: JSON.stringify({
        session: {
          model: MODEL,
          audio: {
            input: {
              transcription: { model: INPUT_TRANSCRIPTION_MODEL },
              noise_reduction: env.NOISE_REDUCTION ? { type: env.NOISE_REDUCTION } : null,
            },
            output: { language: env.TARGET_LANGUAGE || "ja" },
          },
        },
      }),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = data?.error ?? data;
      if (isSpendLimit(upstream.status, detail)) {
        return json({ error: "spend_limit_exceeded", status: upstream.status, detail }, 429, cors);
      }
      // OpenAI 側のエラー内容はそのまま返す(API キーは含まれない)
      return json({ error: "openai_error", status: upstream.status, detail }, 502, cors);
    }

    // ブラウザに必要なのは value(と有効期限)だけ
    return json({ value: data.value, expires_at: data.expires_at }, 200, cors);
  },
};

// 字幕(英語原文・日本語訳)から日本語の要約メモを作る
async function summarize(body, env, cors) {
  const en = typeof body.en === "string" ? body.en : "";
  const ja = typeof body.ja === "string" ? body.ja : "";
  const speakers = typeof body.speakers === "string" ? body.speakers : "";
  const glossary = typeof body.glossary === "string" ? body.glossary.slice(0, 5_000) : "";
  if (!en.trim() && !ja.trim()) return json({ error: "empty_transcript" }, 400, cors);
  if (en.length + ja.length + speakers.length > SUMMARY_MAX_CHARS) return json({ error: "transcript_too_long" }, 413, cors);

  const input = [
    glossary.trim() ? `【用語集(誤り → 正しい)】\n${glossary}` : "",
    speakers.trim() ? `【話者付き書き起こし(英語・話者は音声から自動識別)】\n${speakers}` : "",
    `【英語原文】\n${en || "(なし)"}`,
    `【日本語訳(機械翻訳)】\n${ja || "(なし)"}`,
  ].filter(Boolean).join("\n\n");

  const upstream = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": await sha256Hex(`rt-translate:${env.APP_PASSPHRASE}`),
    },
    body: JSON.stringify({
      model: env.SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
      instructions: SUMMARY_INSTRUCTIONS,
      input,
      max_output_tokens: 2_000,
      store: false,
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = data?.error ?? data;
    if (isSpendLimit(upstream.status, detail)) {
      return json({ error: "spend_limit_exceeded", status: upstream.status, detail }, 429, cors);
    }
    return json({ error: "openai_error", status: upstream.status, detail }, 502, cors);
  }
  const summary = outputText(data).trim();
  if (!summary) return json({ error: "empty_summary" }, 502, cors);
  return json({ summary }, 200, cors);
}

// 録音(audio/mp4 など)を OpenAI の話者分け付き書き起こしに渡す。
// 本文を読み込んで解析せず、multipart の前後だけ付けてそのまま流す(Worker の CPU 時間を使わない)
async function diarize(request, env, cors) {
  const passphrase = request.headers.get("X-Passphrase") || "";
  if (!(await safeEqual(passphrase, env.APP_PASSPHRASE))) {
    return json({ error: "invalid_passphrase" }, 401, cors);
  }
  const size = Number(request.headers.get("Content-Length") || 0);
  if (!size || !request.body) return json({ error: "empty_audio" }, 400, cors);
  if (size > DIARIZE_MAX_BYTES) return json({ error: "audio_too_large" }, 413, cors);

  const type = (request.headers.get("Content-Type") || "audio/mp4").split(";")[0];
  const ext = { "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav" }[type] || "m4a";
  const boundary = `----rt${crypto.randomUUID().replace(/-/g, "")}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = new TextEncoder().encode(
    field("model", env.DIARIZE_MODEL || DEFAULT_DIARIZE_MODEL) +
    field("response_format", "diarized_json") +
    field("chunking_strategy", "auto") +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${type}\r\n\r\n`
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const total = head.length + size + tail.length;

  const { readable, writable } = typeof FixedLengthStream === "function" ? new FixedLengthStream(total) : new TransformStream();
  const pump = (async () => {
    const writer = writable.getWriter();
    await writer.write(head);
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.write(tail);
    await writer.close();
  })();

  const upstreamPromise = fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(total),
      "OpenAI-Safety-Identifier": await sha256Hex(`rt-translate:${env.APP_PASSPHRASE}`),
    },
    body: readable,
    duplex: "half",
  });
  const [upstream] = await Promise.all([upstreamPromise, pump]);
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = data?.error ?? data;
    if (isSpendLimit(upstream.status, detail)) {
      return json({ error: "spend_limit_exceeded", status: upstream.status, detail }, 429, cors);
    }
    return json({ error: "openai_error", status: upstream.status, detail }, 502, cors);
  }
  const segments = (data.segments || [])
    .filter((sg) => typeof sg?.text === "string" && sg.text.trim())
    .map((sg) => ({ speaker: String(sg.speaker ?? "?"), start: Number(sg.start) || 0, end: Number(sg.end) || 0, text: sg.text.trim() }));
  return json({ segments }, 200, cors);
}

// Responses API の出力からテキスト部分を取り出す
function outputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  return (data?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((c) => c?.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

// プロジェクトの月間上限到達(429 project_spend_limit_exceeded など)
function isSpendLimit(status, detail) {
  if (status !== 429) return false;
  const text = `${detail?.code ?? ""} ${detail?.type ?? ""} ${detail?.message ?? ""}`;
  return /spend_limit|insufficient_quota|billing|quota/i.test(text);
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Passphrase",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 長さや内容でタイミング差が出ないよう、ハッシュ同士を定数時間比較する
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
