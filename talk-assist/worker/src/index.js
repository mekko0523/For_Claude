// 会話カンペ(talk-assist)の Cloudflare Worker。
//   - web/ の静的ファイル(画面)を配信する(wrangler.toml の [assets])
//   - POST /api/soniox-key : Soniox の一時キーを発行(長期キーはブラウザに渡さない)
//   - POST /api/suggest    : 相手の英語に対する返答候補を Claude で作り、1行1候補の JSON でストリーミングする
//   - POST /api/memory     : 会話の記録から「覚えておくこと」メモを更新する(過去の発言・話題・話したいこと)
// 合言葉は X-Passphrase ヘッダーで受け取る。
// Secret(値は GitHub Secrets → Actions 経由で登録。ここには書かない):
//   ANTHROPIC_API_KEY, SONIOX_API_KEY, APP_PASSPHRASE
import Anthropic from "@anthropic-ai/sdk";

const SONIOX_TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
const DEFAULT_SONIOX_MODEL = "stt-rt-v5";
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const DEFAULT_CLAUDE_EFFORT = "low"; // 会話中に待たせないよう、考える量は少なめ
const MAX_HISTORY = 30;              // Claude に渡す直近の発言数
const MAX_TEXT = 1_000;              // 1発言の最大文字数
const MAX_NOTE = 4_000;              // 自己紹介・覚えておくこと・話したいことの最大文字数
const MAX_MEMORY_TURNS = 300;        // メモ更新に渡す発言数の上限

const SYSTEM_PROMPT = `You help a Japanese speaker who cannot speak English hold a live, face-to-face conversation in English.
The app transcribes what the other person ("Them") says. The user reads one of your suggestions aloud as their reply ("Me").

Write 4 short things the user could say next:
- 1-2 natural direct answers or reactions to Them's latest words (if it is a yes/no question, cover both a positive and a negative option)
- 1 follow-up question that keeps the conversation going
- 1 more option that fits best: another answer, a polite clarification, or a short comment

Rules:
- Spoken, natural, easy English that a beginner can read aloud: usually 4-14 words, at most 2 short sentences.
- Fit the conversation so far and the user's profile/scene. Never invent personal facts that contradict the profile.
  If an answer needs a fact you don't know (a time, a number, a name), offer a plausible concrete choice rather than a placeholder.
- The transcript comes from speech recognition and may contain errors or cut-off sentences; infer the most likely meaning.
- If the user gives an intent in Japanese ("言いたいこと"), all suggestions must express that intent in different ways.
- "Memory" holds notes from the user's past conversations (facts they said about themselves, past topics, people they know).
  Use it so answers stay consistent with what the user has said before and feel personal; never contradict it.
- "Topics I want to talk about": when there is a natural opening (a pause, a "what about you?", a topic change),
  make the "other" option bring up one of them.
- "ja" is a short, natural Japanese translation so the user knows what they are saying.

Output format: exactly one JSON object per line (JSON Lines), nothing else — no code fences, no commentary.
First, for each message tagged like [T3], one translation line with a natural Japanese translation of that message
(fix obvious speech-recognition errors from context):
{"kind":"translation","id":"T3","ja":"..."}
Then the suggestions:
{"kind":"answer","en":"...","ja":"..."}
Suggestion kind is one of: "answer", "question", "other".
Latency-sensitive; begin your visible answer immediately.`;

// 場面が英会話教室のときに足す指示
const LESSON_GUIDE = `This is a 1-on-1 English lesson; "Them" is the user's English teacher.
- The teacher may ask questions, correct the user's English, explain words, or give small tasks. Help the user take part actively.
- Answers may be a little richer (one reason or example) but must stay easy to read aloud.
- If the teacher corrects the user, include one option that repeats the corrected sentence.
- If the teacher uses a difficult word or idiom, include an option asking about it (e.g. "What does 'X' mean?" / "Could you give me an example?").
- Useful lesson phrases are welcome: asking the teacher to correct a sentence, to repeat, to speak slowly, or how to say something.
- Use the memory for continuity across lessons (what was practiced before, the user's goals and weak points).`;

const MEMORY_PROMPT = `You maintain a compact memory notebook for a Japanese user who uses an app to hold English conversations.
You get the current notebook and a new conversation transcript ("Me" = the user, "Them" = the other person).
Return the updated notebook.

Sections (keep these exact Japanese headings, omit a section only if it has nothing):
■ 自分について（話した事実）: facts the user said about themselves (job, family, hobbies, plans, opinions) — keep the English key phrases they used when useful
■ 相手について: who they talk with (names, the teacher's name and background, what those people said about themselves)
■ これまでの話題: short list of topics already discussed, newest first, with dates if given
■ 次に話したいこと・続きの話: open threads, promises, questions left unanswered, things to follow up next time
■ 英語の学習メモ: corrections received, new words/phrases, weak points (mainly for English lessons)

Rules:
- Bullet points starting with "・". Write in Japanese; keep important English words/phrases in English.
- Merge with the existing notebook: keep still-valid facts, update changed ones, remove duplicates and trivial details.
- Only record what was actually said. The transcript comes from speech recognition and may contain errors; skip anything unclear.
- Keep the whole notebook under about 2500 Japanese characters; drop the oldest, least useful items first.
- Output only the notebook text, with no preamble.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // 静的ファイルにないパスはトップページへ
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    // 画面と同じオリジン以外からの呼び出しは断る(他サイトから API を使わせない)
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "forbidden_origin" }, 403);
    if (!env.APP_PASSPHRASE) return json({ error: "server_not_configured" }, 500);
    if (!(await safeEqual(request.headers.get("X-Passphrase") || "", env.APP_PASSPHRASE))) {
      return json({ error: "invalid_passphrase" }, 401);
    }

    if (url.pathname === "/api/soniox-key") return sonioxKey(env);
    if (url.pathname === "/api/suggest") return suggest(request, env);
    if (url.pathname === "/api/memory") return updateMemory(request, env);
    return json({ error: "not_found" }, 404);
  },
};

// Soniox 用の一時キー(1回だけ・60秒以内に接続開始に使う)
async function sonioxKey(env) {
  if (!env.SONIOX_API_KEY) return json({ error: "soniox_not_configured" }, 500);
  const upstream = await fetch(SONIOX_TEMP_KEY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      usage_type: "transcribe_websocket",
      expires_in_seconds: 60,
      single_use: true,
      client_reference_id: "talk-assist",
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data.api_key) {
    return json({ error: "soniox_error", status: upstream.status, message: data?.error_message || "" }, 502);
  }
  return json({ value: data.api_key, model: env.SONIOX_MODEL || DEFAULT_SONIOX_MODEL }, 200);
}

// 返答候補。Claude の出力(JSON Lines)を届いた順にそのまま流し、ブラウザ側で1行ずつ表示する
async function suggest(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((h) => (h?.who === "them" || h?.who === "me") && typeof h.en === "string" && h.en.trim())
    .slice(-MAX_HISTORY)
    .map((h) => {
      // 和訳がほしい相手の発言には [T<id>] を付ける
      const tag = h.who === "them" && h.translate && /^\d{1,9}$/.test(String(h.id)) ? ` [T${h.id}]` : "";
      return `${h.who === "me" ? "Me" : "Them"}${tag}: ${clean(h.en)}`;
    });
  if (!history.length && !body.intent) return json({ error: "empty_history" }, 400);

  const parts = [
    body.lesson ? LESSON_GUIDE : "",
    body.profile ? `User profile (written by the user, may be Japanese):\n${clean(body.profile, MAX_NOTE)}` : "",
    body.memory ? `Memory (from past conversations):\n${clean(body.memory, MAX_NOTE)}` : "",
    body.topics ? `Topics I want to talk about:\n${clean(body.topics, MAX_NOTE)}` : "",
    body.scene ? `Scene: ${clean(body.scene)}` : "",
    `Conversation so far (latest last):\n${history.join("\n") || "(nothing yet)"}`,
    body.intent ? `言いたいこと (the user's intent, in Japanese): ${clean(body.intent)}` : "",
    "Write the suggestions now.",
  ].filter(Boolean);

  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const fallback = fallbackParams(model);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const write = (s) => writer.write(encoder.encode(s)).catch(() => {});

  (async () => {
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 4_000,
          output_config: { effort: env.CLAUDE_EFFORT || DEFAULT_CLAUDE_EFFORT },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: parts.join("\n\n") }],
          ...fallback,
        },
        { signal: request.signal },
      );
      stream.on("text", (text) => write(text));
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") write(`\n${JSON.stringify({ error: "refusal" })}\n`);
      else if (final.stop_reason === "max_tokens") write(`\n${JSON.stringify({ error: "max_tokens" })}\n`);
    } catch (err) {
      if (!request.signal.aborted) write(`\n${JSON.stringify({ error: errorCode(err), message: String(err?.message || err).slice(0, 300) })}\n`);
    } finally {
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// 会話の記録から「覚えておくこと」メモを作り直す(会話の終わりにだけ呼ばれる)
async function updateMemory(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const turns = (Array.isArray(body.turns) ? body.turns : [])
    .filter((h) => (h?.who === "them" || h?.who === "me") && typeof h.en === "string" && h.en.trim())
    .slice(-MAX_MEMORY_TURNS)
    .map((h) => `${h.who === "me" ? "Me" : "Them"}: ${clean(h.en)}`);
  if (!turns.length) return json({ error: "empty_history" }, 400);

  const input = [
    body.profile ? `User profile:\n${clean(body.profile, MAX_NOTE)}` : "",
    body.scene ? `Scene: ${clean(body.scene)}` : "",
    body.date ? `Date: ${clean(body.date, 40)}` : "",
    `Current notebook:\n${body.memory ? clean(body.memory, MAX_NOTE * 2) : "(empty)"}`,
    `New conversation:\n${turns.join("\n")}`,
  ].filter(Boolean).join("\n\n");

  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const msg = await client.beta.messages.create({
      model,
      max_tokens: 8_000,
      output_config: { effort: env.CLAUDE_EFFORT || DEFAULT_CLAUDE_EFFORT },
      system: MEMORY_PROMPT,
      messages: [{ role: "user", content: input }],
      ...fallbackParams(model),
    });
    if (msg.stop_reason === "refusal") return json({ error: "refusal" }, 502);
    const memory = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!memory) return json({ error: "empty_memory" }, 502);
    return json({ memory }, 200);
  } catch (err) {
    return json({ error: errorCode(err), message: String(err?.message || err).slice(0, 300) }, 502);
  }
}

// 安全上の判定で断られたとき、サーバー側で別のモデルに任せる(Haiku は非対応)
function fallbackParams(model) {
  return /opus|sonnet|fable/.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

function errorCode(err) {
  if (err instanceof Anthropic.AuthenticationError) return "anthropic_auth";
  if (err instanceof Anthropic.RateLimitError) return "rate_limited";
  if (err instanceof Anthropic.BadRequestError) return "bad_request";
  if (err instanceof Anthropic.APIStatusError) return `anthropic_${err.status}`;
  if (err instanceof Anthropic.APIConnectionError) return "connection";
  return "unknown";
}

function clean(s, max = MAX_TEXT) {
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, max);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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
