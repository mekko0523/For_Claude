// client secret を発行するだけの Cloudflare Worker。
// OPENAI_API_KEY は Worker Secret にのみ保存し、ブラウザには短時間有効な client secret だけを返す。
// Secret(値は GitHub Secrets → Actions 経由で登録。ここには書かない):
//   OPENAI_API_KEY, APP_PASSPHRASE

const OPENAI_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
const MODEL = "gpt-realtime-translate";
// 英語原文の文字起こし(session.input_transcript.delta)に必要
const INPUT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

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

    if (url.pathname !== "/session") {
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
    "Access-Control-Allow-Headers": "Content-Type",
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
