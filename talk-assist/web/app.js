"use strict";

// ===== 定数(ここを変えれば挙動を調整できる) =====
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_SAMPLE_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 20_000;
const SILENCE_STOP_MS = 5 * 60_000;     // 何も聞こえないままこの時間たったら自動停止(料金の節約)
const MAX_RECONNECTS = 5;               // 接続が切れたときに自動でつなぎ直す回数
const MAX_TURNS = 300;                  // 1つの会話に残す発言数
const MAX_CONVS = 60;                   // 端末に残す会話の数(古いものから消える)
// 使用量の表示(概算)。Soniox は送った音声の長さで課金される。Claude の料金は Worker が計算して返す
const SONIOX_USD_PER_HOUR = 0.12;
const PCM_BYTES_PER_SEC = SONIOX_SAMPLE_RATE * 2; // 16kHz・16bit・モノラル
const MEMORY_MIN_NEW_TURNS = 4;         // 新しい発言がこれ以上あれば、停止時に「覚えていること」を更新する
// 場面(画面上部のボタンで切り替え)。mode があるものは Worker で専用の指示を足す
const SCENES = [
  { key: "", label: "指定なし", en: "" },
  { key: "lesson", label: "英会話教室", en: "English lesson with a teacher at an English conversation school", mode: "lesson" },
  { key: "meeting", label: "社内会議", en: "Internal company meeting with colleagues, held in English", mode: "meeting" },
  { key: "business", label: "商談・展示会", en: "Business meeting or trade show with a client" },
  { key: "travel", label: "旅行", en: "Travel abroad (hotel, airport, sightseeing)" },
  { key: "shop", label: "買い物・食事", en: "Shopping or ordering at a restaurant or cafe" },
  { key: "chat", label: "雑談", en: "Casual small talk with a new acquaintance" },
  { key: "help", label: "道案内・困りごと", en: "Asking for help or directions" },
];
// 以前の版で保存した場面の英文 → 新しい場面
const OLD_SCENES = { "English lesson: 1-on-1 online or in-person lesson with an English teacher": "lesson" };
const HISTORY_FOR_CLAUDE = 30;          // 候補作りに使う直近の発言数
// 自分の発言の見分け: 表示中の候補を読み上げたら「自分」とみなす
const SELF_MATCH_DICE = 0.6;            // 候補との単語の一致度(Dice 係数)がこれ以上
const SELF_MATCH_CONTAINED = 0.8;       // または、聞こえた単語のこの割合以上が候補に含まれる(3語以上)
const PICKED_ECHO_MS = 30_000;          // 候補をタップしてからこの時間は、それを読み上げた声を二重に記録しない
const LS = {
  pass: "ta.passphrase", profile: "ta.profile", scene: "ta.scene", oldScene: "ta.scenePreset",
  endpoint: "ta.endpoint", showJa: "ta.showJa", turns: "ta.turns", model: "ta.model",
  convs: "ta.convs", current: "ta.currentConv", memory: "ta.memory",
};

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const logEl = $("log");
const liveEl = $("live");
const emptyEl = $("empty");
const cardsEl = $("cards");
const sgTitle = $("sgTitle");
const regenBtn = $("regenBtn");
const meBtn = $("meBtn");
const toggleBtn = $("toggleBtn");
const dotEl = $("dot");
const statusText = $("statusText");
const noticeEl = $("notice");
const settings = $("settings");
const passInput = $("passphrase");
const profileInput = $("profile");
const sceneBar = $("sceneBar");
const endpointSel = $("endpointSel");
const showJa = $("showJa");
const modelSel = $("modelSel");
const intentForm = $("intentForm");
const intentInput = $("intent");
const memoryInput = $("memory");
const memoryBtn = $("memoryBtn");
const notesDlg = $("notes");
const notesStatus = $("notesStatus");
const historyDlg = $("history");
const histList = $("histList");
const histView = $("histView");
const histText = $("histText");
const histUsage = $("histUsage");
const usageEl = $("usage");
const histTitle = $("histTitle");

// ===== 状態 =====
let state = "idle";              // idle | connecting | live
let generation = 0;              // 停止後に古い非同期処理が戻ってきても無視するための世代番号
let ws = null;
let audio = null;                // { ctx, node, stream }
let wakeLock = null;
let reconnects = 0;
let lastHeardAt = 0;
let tickTimer = null;
let uttFinal = "";               // 話し中の発言の確定部分
let uttJa = "";                  // 話し中の発言の和訳(確定部分)
let uttStarted = false;          // 前の発言の区切りのあと、次の発言の原文が届き始めたか
let lateJaTarget = null;         // 区切りのあとに遅れて届いた和訳を足す発言
let meMode = false;              // 「自分が話す」ボタンが押されている間は、聞こえた声を自分の発言にする
// 会話は端末に複数残す: [{ id, startedAt, updatedAt, scene, memUpTo, turns: [{ id, who: "them" | "me", en, ja }] }]
let convs = loadConvs();
let conv = convs.find((c) => c.id === lsGet(LS.current)) || newConv();
let turns = conv.turns;
let nextId = turns.reduce((m, t) => Math.max(m, t.id), 0) + 1;
let memoryBusy = false;
let notesDirty = false;          // 自己紹介メモ・覚えていることを書き換えて、まだサーバーに保存していない
let notesTimer = null;
let viewingConv = null;          // 記録画面で開いている会話
let suggestions = [];            // 表示中の候補 [{ kind, en, ja }]
let picked = null;               // タップした候補 { en, words: Set, at, covered: Set }
let suggestCtl = null;           // 候補作りの通信(新しい発言が来たら取り消す)

// ===== 初期化 =====
passInput.value = lsGet(LS.pass) || "";
// 自己紹介メモと覚えていることはサーバーに保存する。端末の値は表示を速くするための控え
profileInput.value = lsGet(LS.profile) || "";
let sceneKey = lsGet(LS.scene) ?? migrateScene(lsGet(LS.oldScene));
renderSceneBar();
endpointSel.value = lsGet(LS.endpoint) || "1200";
showJa.checked = lsGet(LS.showJa) !== "0";
modelSel.value = lsGet(LS.model) === "opus" ? "opus" : "haiku";
memoryInput.value = lsGet(LS.memory) || "";
applyShowJa();
renderLog();

toggleBtn.addEventListener("click", () => (state === "idle" ? start() : stop()));
$("settingsBtn").addEventListener("click", () => settings.showModal());
$("newBtn").addEventListener("click", newConversation);
$("historyBtn").addEventListener("click", openHistory);
$("histClose").addEventListener("click", () => historyDlg.close());
$("histBack").addEventListener("click", showHistoryList);
$("histCopy").addEventListener("click", () => viewingConv && copyText(formatConv(viewingConv)));
$("histContinue").addEventListener("click", () => viewingConv && continueConv(viewingConv));
$("histDelete").addEventListener("click", () => viewingConv && deleteConv(viewingConv));
memoryBtn.addEventListener("click", () => updateMemory(conv, { force: true }));
$("notesBtn").addEventListener("click", () => { loadNotes(); notesDlg.showModal(); });
$("notesClose").addEventListener("click", () => notesDlg.close());
notesDlg.addEventListener("close", () => saveNotes());
for (const box of [profileInput, memoryInput]) {
  box.addEventListener("input", () => { notesDirty = true; clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 1_500); });
  box.addEventListener("blur", () => saveNotes());
}
regenBtn.addEventListener("click", () => requestSuggestions());
meBtn.addEventListener("click", () => setMeMode(!meMode));
intentForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const intent = intentInput.value.trim();
  if (!intent) return;
  intentInput.blur();
  requestSuggestions({ intent });
});
settings.addEventListener("close", saveSettings);
showJa.addEventListener("change", applyShowJa);
document.addEventListener("visibilitychange", onVisibility);

if (!passInput.value) settings.showModal();
else loadNotes();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ===== 開始・停止 =====
async function start() {
  if (state !== "idle") return;
  const pass = passInput.value.trim();
  if (!pass) { settings.showModal(); return; }
  const gen = ++generation;
  setState("connecting");
  showNotice("");
  reconnects = 0;
  try {
    // iOS では音声処理をボタンを押した直後に作らないと動かないことがあるため、最初に作る
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    ctx.resume?.().catch(() => {});
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("このブラウザはマイクに対応していません（Safari で開いてください）");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (gen !== generation) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); return; }
    audio = { ctx, stream, node: null };
    await setupAudio(ctx, stream);
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (state !== "idle") stop("マイクが止まりました。もう一度「開始」を押してください", true);
    });
    await connect(gen);
    if (gen !== generation) return;
    acquireWakeLock();
    lastHeardAt = Date.now();
    tickTimer = setInterval(tick, 1_000);
    setState("live");
  } catch (err) {
    if (gen !== generation) return;
    stop(err?.message || String(err), true);
  }
}

function stop(message = "", isError = false) {
  generation++;
  if (uttFinal.trim()) endUtterance();
  closeSocket();
  if (audio) {
    try { audio.node?.disconnect(); } catch {}
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close().catch(() => {});
    audio = null;
  }
  clearInterval(tickTimer);
  tickTimer = null;
  releaseWakeLock();
  setLive("");
  setState("idle");
  if (message) showNotice(message, isError);
  if (hasUsage(conv)) saveTurns(); // 聞き取った時間を保存
  renderUsage();
  updateMemory(conv);
}

function tick() {
  renderUsage();
  if (state === "live" && Date.now() - lastHeardAt > SILENCE_STOP_MS) {
    stop("しばらく何も聞こえなかったので停止しました");
  }
}

// ===== 音声(マイク → 16kHz の 16bit PCM → Soniox) =====
const PCM_WORKLET_SRC = `
class PcmSender extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ratio = o.processorOptions.ratio; this.pos = 0; this.sum = 0; this.n = 0;
    this.out = new Int16Array(1600); this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0; this.n = 0;
        this.out[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.len === this.out.length) {
          const buf = this.out.slice(0).buffer;
          this.port.postMessage(buf, [buf]);
          this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-sender", PcmSender);
`;

async function setupAudio(ctx, stream) {
  const url = URL.createObjectURL(new Blob([PCM_WORKLET_SRC], { type: "application/javascript" }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-sender", { processorOptions: { ratio: ctx.sampleRate / SONIOX_SAMPLE_RATE } });
  const mute = ctx.createGain();
  mute.gain.value = 0; // 処理を動かすためにつなぐだけ(音は出さない)
  src.connect(node).connect(mute).connect(ctx.destination);
  node.port.onmessage = ({ data }) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
      usageOf(conv).sonioxBytes += data.byteLength;
    }
  };
  await ctx.resume?.().catch(() => {});
  audio.node = node;
}

// ===== Soniox =====
async function connect(gen) {
  const res = await api("/api/soniox-key", {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.value) throw new Error(apiErrorMessage(res.status, data, "音声認識の準備"));
  if (gen !== generation) return;

  const sock = new WebSocket(SONIOX_WS_URL, ["soniox-api-key", data.value]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("音声認識への接続がタイムアウトしました")), CONNECT_TIMEOUT_MS);
    sock.onopen = () => {
      clearTimeout(timer);
      sock.send(JSON.stringify({
        model: data.model || "stt-rt-v5",
        audio_format: "pcm_s16le",
        sample_rate: SONIOX_SAMPLE_RATE,
        num_channels: 1,
        language_hints: ["en"],
        // 相手の発言の和訳は Soniox が話しながら出す(候補作りの AI は候補だけを書くので速い)
        translation: { type: "one_way", target_language: "ja" },
        enable_endpoint_detection: true,
        max_endpoint_delay_ms: Number(endpointSel.value) || 1200,
        context: {
          general: [
            { key: "setting", value: "Face-to-face conversation in English" },
            ...(sceneText() ? [{ key: "scene", value: sceneText().slice(0, 300) }] : []),
          ],
        },
      }));
      resolve();
    };
    sock.onerror = () => { clearTimeout(timer); reject(new Error("音声認識に接続できませんでした")); };
  });
  if (gen !== generation) { try { sock.close(); } catch {} return; }
  sock.onerror = null;
  sock.onmessage = (e) => { if (sock === ws) handleSoniox(e.data); };
  sock.onclose = (e) => {
    if (sock !== ws || gen !== generation || state === "idle") return;
    ws = null;
    if (reconnects >= MAX_RECONNECTS) {
      stop(`音声認識との接続が切れました（${e.code}）。もう一度「開始」を押してください`, true);
      return;
    }
    reconnects++;
    setState("connecting");
    setTimeout(() => {
      if (gen !== generation) return;
      connect(gen).then(() => { if (gen === generation) setState("live"); })
        .catch((err) => { if (gen === generation) stop(err?.message || String(err), true); });
    }, 800);
  };
  ws = sock;
}

function closeSocket() {
  const sock = ws;
  ws = null;
  if (!sock) return;
  try { if (sock.readyState === WebSocket.OPEN) sock.send(""); } catch {} // 空のフレーム = 音声の終わり
  setTimeout(() => { try { sock.close(); } catch {} }, 500);
}

// tokens の is_final が確定、それ以外は暫定(あとで変わる)。<end> は話し終わりの合図
function handleSoniox(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.error_code || msg.error_message) {
    stop(`音声認識のエラー: ${msg.error_message || msg.error_code}`, true);
    return;
  }
  let prov = "";
  let provJa = "";
  let lateJa = "";
  for (const t of msg.tokens || []) {
    if (t.text === "<end>" || t.text === "<fin>") {
      if (t.is_final) endUtterance();
      continue;
    }
    if (t.translation_status === "translation") {
      // 和訳は原文より少し遅れて届く。次の発言が始まる前に届いた分は、直前の発言の和訳
      if (!t.is_final) provJa += t.text;
      else if (!uttStarted && lateJaTarget) lateJa += t.text;
      else uttJa += t.text;
      continue;
    }
    lastHeardAt = Date.now();
    uttStarted = true;
    if (t.is_final) uttFinal += t.text;
    else prov += t.text;
  }
  if (lateJa) appendLateJa(lateJa);
  setLive(uttFinal + prov, uttJa + provJa);
}

// 記録済みの発言に、遅れて届いた和訳を足す(自分の発言の和訳は候補のものを使うので捨てる)
function appendLateJa(text) {
  const t = lateJaTarget;
  if (!t || t.who !== "them") return;
  t.ja = (t.ja + text).replace(/^\s+/, "");
  logEl.querySelector(`[data-id="${t.id}"]`)?.replaceWith(renderTurn(t));
  saveTurns();
}

// 1つの発言が終わった: 自分の発言か相手の発言かを見分けて記録する
function endUtterance() {
  const text = uttFinal.replace(/\s+/g, " ").trim();
  const ja = uttJa.trim();
  uttFinal = "";
  uttJa = "";
  uttStarted = false;
  lateJaTarget = { who: "none" }; // 遅れて届いた和訳を次の発言に混ぜないための捨て先(相手の発言なら下で差し替え)
  setLive("");
  if (!/[a-z0-9]/i.test(text)) return;

  if (meMode) {
    intentInput.value = "";
    lateJaTarget = addTurn({ who: "me", en: text, ja });
    return;
  }
  const words = toWords(text);
  // タップした候補を読み上げた声(すでに記録済み)
  if (picked && Date.now() - picked.at < PICKED_ECHO_MS && containedRatio(words, picked.words) >= 0.7) {
    for (const w of words) picked.covered.add(w);
    if (picked.covered.size >= picked.words.size * 0.7) picked = null;
    return;
  }
  // 表示中の候補を読み上げた
  const match = bestSuggestion(words);
  if (match) {
    intentInput.value = "";
    addTurn({ who: "me", en: match.en, ja: match.ja });
    clearSuggestions("相手の返事を待っています…");
    return;
  }
  lateJaTarget = addTurn({ who: "them", en: text, ja });
  requestSuggestions();
}

function bestSuggestion(words) {
  let best = null;
  let bestScore = 0;
  for (const s of suggestions) {
    const sw = toWords(s.en);
    const d = dice(words, sw);
    const ok = d >= SELF_MATCH_DICE || (words.size >= 3 && containedRatio(words, sw) >= SELF_MATCH_CONTAINED);
    if (ok && d > bestScore) { best = s; bestScore = d; }
  }
  return best;
}

function toWords(text) {
  return new Set(text.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean));
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return (2 * n) / (a.size + b.size);
}
function containedRatio(a, b) {
  if (!a.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

// ===== 返答候補(Claude) =====
// 言いたいことの欄に何か入っていれば、相手が話したときの候補作りにも使う
async function requestSuggestions({ intent = intentInput.value.trim() } = {}) {
  if (!turns.length && !intent) return;
  if (!passInput.value.trim()) { settings.showModal(); return; }
  suggestCtl?.abort();
  const ctl = new AbortController();
  suggestCtl = ctl;
  suggestions = [];
  picked = null;
  cardsEl.replaceChildren(...[0, 1, 2].map(() => el("div", "loading")));
  sgTitle.textContent = intent ? `「${intent}」の言い方` : "返答候補";
  regenBtn.disabled = true;

  const history = turns.slice(-HISTORY_FOR_CLAUDE).map((t) => ({
    id: t.id, who: t.who, en: t.en,
  }));
  let shown = 0;
  const startedAt = performance.now();
  const title = sgTitle.textContent;
  try {
    const res = await api("/api/suggest", {
      history, intent, scene: sceneText(), mode: currentScene().mode || "",
      profile: profileInput.value.trim(), memory: memoryInput.value.trim(), model: modelSel.value,
    }, ctl.signal);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(apiErrorMessage(res.status, data, "候補作り"));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0 || (done && buf.trim())) {
        const line = (nl >= 0 ? buf.slice(0, nl) : buf).trim();
        buf = nl >= 0 ? buf.slice(nl + 1) : "";
        if (ctl !== suggestCtl) return;
        if (handleSuggestionLine(line) && ++shown === 1) {
          // 最初の候補が出るまでの時間(モデルの速さの比較用)
          const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
          sgTitle.textContent = `${title} ・ ${sec}秒（${modelSel.value === "opus" ? "Opus" : "Haiku"}）`;
        }
      }
      if (done) break;
    }
  } catch (err) {
    if (ctl.signal.aborted || ctl !== suggestCtl) return;
    showNotice(err?.message || String(err), true);
  } finally {
    if (ctl === suggestCtl) {
      suggestCtl = null;
      cardsEl.querySelectorAll(".loading").forEach((n) => n.remove());
      if (!shown) setCardsPlaceholder("候補を作れませんでした。「別の候補」で作り直せます");
      regenBtn.disabled = !turns.length;
    }
  }
}

// 1行 = 1つの JSON。和訳なら発言に付け、候補ならカードを足す。カードを足したら true
function handleSuggestionLine(line) {
  if (!line.startsWith("{")) return false;
  let obj;
  try { obj = JSON.parse(line); } catch { return false; }
  if (obj.error) {
    showNotice(obj.error === "refusal" ? "この内容では候補を作れませんでした" : `候補作りでエラー: ${obj.message || obj.error}`, true);
    return false;
  }
  if (obj.kind === "usage") {
    addClaudeUsage(conv, obj);
    return false;
  }
  if (obj.kind === "translation") {
    const id = Number(String(obj.id || "").replace(/^T/, ""));
    const turn = turns.find((t) => t.id === id);
    if (turn && typeof obj.ja === "string") {
      turn.ja = obj.ja;
      saveTurns();
      const node = logEl.querySelector(`[data-id="${id}"]`);
      if (node) node.replaceWith(renderTurn(turn));
    }
    return false;
  }
  if (typeof obj.en !== "string" || !obj.en.trim()) return false;
  const s = { kind: obj.kind, en: obj.en.trim(), ja: typeof obj.ja === "string" ? obj.ja : "" };
  suggestions.push(s);
  const card = el("button", `card ${["question", "other"].includes(s.kind) ? s.kind : "answer"}`);
  card.type = "button";
  // 種類は左の色と和訳の頭の小さな文字で示す(縦の幅を節約して4つを1画面に収める)
  const ja = el("div", "ja");
  ja.append(el("span", "kind", { answer: "返事", question: "質問", other: "ほか" }[s.kind] || "返事"), document.createTextNode(s.ja));
  card.append(el("div", "en", s.en), ja);
  card.addEventListener("click", () => pickSuggestion(s, card));
  const firstLoading = cardsEl.querySelector(".loading");
  cardsEl.insertBefore(card, firstLoading);
  return true;
}

// 候補をタップ = これを言う。会話に記録して、読み上げた声を二重に記録しないようにする
function pickSuggestion(s, card) {
  card.classList.add("picked");
  intentInput.value = ""; // 返事をしたら、言いたいことの欄は次の言葉のために空ける
  addTurn({ who: "me", en: s.en, ja: s.ja });
  picked = { en: s.en, words: toWords(s.en), at: Date.now(), covered: new Set() };
  suggestions = [];
  setTimeout(() => clearSuggestions("相手の返事を待っています…"), 400);
}

function clearSuggestions(text) {
  suggestCtl?.abort();
  suggestCtl = null;
  suggestions = [];
  sgTitle.textContent = "返答候補";
  setCardsPlaceholder(text);
  regenBtn.disabled = !turns.length;
}

function setCardsPlaceholder(text) {
  cardsEl.replaceChildren(...(text ? [el("div", "placeholder", text)] : []));
}

// ===== 会話ログ =====
function addTurn({ who, en, ja = "" }) {
  const turn = { id: nextId++, who, en, ja };
  turns.push(turn);
  if (turns.length > MAX_TURNS) {
    const old = turns.shift();
    logEl.querySelector(`[data-id="${old.id}"]`)?.remove();
  }
  if (turns.length === 1) conv.scene = sceneText();
  saveTurns();
  logEl.insertBefore(renderTurn(turn), liveEl);
  updateEmpty();
  scrollToBottom();
  return turn;
}

function renderTurn(t) {
  const node = el("div", `turn ${t.who}`);
  node.dataset.id = t.id;
  node.append(el("div", "who", t.who === "me" ? "自分" : "相手"), el("div", "en", t.en));
  if (t.ja) node.append(el("div", "ja", t.ja));
  node.addEventListener("click", () => editTurn(t));
  return node;
}

// 発言をタップ: 相手 → 自分 に直す / 自分の発言を取り消す(聞き分けの間違いを直す用)
function editTurn(t) {
  if (t.who === "them") {
    if (!confirm("この発言を「自分」の発言に直しますか？")) return;
    t.who = "me";
    saveTurns();
    logEl.querySelector(`[data-id="${t.id}"]`)?.replaceWith(renderTurn(t));
    if (turns[turns.length - 1] === t) clearSuggestions("相手の返事を待っています…");
    return;
  }
  if (!confirm("この発言を会話から消しますか？")) return;
  const i = turns.indexOf(t);
  if (i >= 0) turns.splice(i, 1);
  saveTurns();
  logEl.querySelector(`[data-id="${t.id}"]`)?.remove();
  updateEmpty();
  if (turns[turns.length - 1]?.who === "them") requestSuggestions();
}

function setLive(text, ja = "") {
  const show = text.trim();
  liveEl.hidden = !show;
  liveEl.firstElementChild.textContent = show;
  liveEl.lastElementChild.textContent = show ? ja.trim() : "";
  if (show) { updateEmpty(); scrollToBottom(); }
}

// 新しい会話: 今の会話は記録に残し、「覚えていること」に反映してから空の会話にする
function newConversation() {
  if (!turns.length) return;
  if (!confirm("新しい会話を始めますか？（今の会話は 📜 記録 に残ります）")) return;
  if (state !== "idle") stop();
  updateMemory(conv, { force: true });
  switchConv(newConv());
  showNotice("");
}

function switchConv(c) {
  conv = c;
  turns = c.turns;
  nextId = turns.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  picked = null;
  lsSet(LS.current, c.id);
  renderLog();
}

// ===== 使用量(会話ごと) =====
function emptyUsage() {
  return { claudeCalls: 0, claudeIn: 0, claudeOut: 0, claudeUsd: 0, sonioxBytes: 0 };
}
function usageOf(c) {
  if (!c.usage) c.usage = emptyUsage();
  return c.usage;
}
function hasUsage(c) {
  const u = usageOf(c);
  return u.claudeCalls > 0 || u.sonioxBytes > 0;
}
function addClaudeUsage(c, u) {
  if (!u || typeof u.usd !== "number") return;
  const x = usageOf(c);
  x.claudeCalls++;
  x.claudeIn += u.input || 0;
  x.claudeOut += u.output || 0;
  x.claudeUsd += u.usd;
  saveTurns();
  renderUsage();
}
function sonioxSec(c) { return usageOf(c).sonioxBytes / PCM_BYTES_PER_SEC; }
function sonioxUsd(c) { return (sonioxSec(c) / 3600) * SONIOX_USD_PER_HOUR; }
function totalUsd(c) { return usageOf(c).claudeUsd + sonioxUsd(c); }
// 金額はドルで表示する(Haiku の1回分のような小さな額も見えるよう、1セント未満は小数4桁)
function fmtMoney(usd) {
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}
function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}分${s}秒` : `${s}秒`;
}
function renderUsage() {
  // Claude と Soniox の合計(内訳は 📜 で会話を開くと見られる)
  usageEl.textContent = hasUsage(conv) ? fmtMoney(totalUsd(conv)) : "";
}
function renderUsageDetail(c) {
  const u = usageOf(c);
  histUsage.replaceChildren();
  const line = (label, text) => {
    const d = el("div");
    d.append(el("b", null, label), document.createTextNode(` ${text}`));
    histUsage.append(d);
  };
  line("Claude", `${u.claudeCalls}回 ・ 入力 ${u.claudeIn.toLocaleString()} / 出力 ${u.claudeOut.toLocaleString()} トークン ・ ${fmtMoney(u.claudeUsd)}`);
  line("Soniox", `${fmtDuration(sonioxSec(c))} ・ ${fmtMoney(sonioxUsd(c))}`);
  line("合計（Claude＋Soniox）", `${fmtMoney(totalUsd(c))}（概算）`);
}

function renderLog() {
  logEl.querySelectorAll(".turn:not(.live)").forEach((n) => n.remove());
  for (const t of turns) logEl.insertBefore(renderTurn(t), liveEl);
  updateEmpty();
  scrollToBottom(true);
  renderUsage();
  clearSuggestions(turns.length ? "相手が話すと、ここに返事の候補が出ます" : "");
}

// ===== 会話の記録 =====
function newConv() {
  const now = Date.now();
  return { id: `c${now.toString(36)}`, startedAt: now, updatedAt: now, scene: "", memUpTo: 0, turns: [], usage: emptyUsage() };
}

function openHistory() {
  showHistoryList();
  historyDlg.showModal();
}

function showHistoryList() {
  viewingConv = null;
  histView.hidden = true;
  histList.hidden = false;
  histTitle.textContent = "会話の記録";
  const list = [conv, ...convs.filter((c) => c !== conv)].filter((c) => c.turns.length || hasUsage(c));
  if (!list.length) {
    histList.replaceChildren(el("p", "hint", "まだ記録はありません"));
    return;
  }
  histList.replaceChildren(...list.map((c) => {
    const item = el("button", `hist-item${c === conv ? " current" : ""}`);
    item.type = "button";
    item.append(
      el("div", "meta", `${fmtDate(c.startedAt)}${c === conv ? "（今の会話）" : ""} ・ ${sceneLabel(c.scene)} ・ ${c.turns.length}発言 ・ ${fmtMoney(totalUsd(c))}`),
      el("div", "first", c.turns[0]?.en || "（発言なし）"),
    );
    item.addEventListener("click", () => showHistoryConv(c));
    return item;
  }));
}

function showHistoryConv(c) {
  viewingConv = c;
  histList.hidden = true;
  histView.hidden = false;
  histTitle.textContent = fmtDate(c.startedAt);
  histText.textContent = formatConv(c);
  renderUsageDetail(c);
  $("histContinue").hidden = c === conv;
}

function continueConv(c) {
  if (state !== "idle") stop();
  else updateMemory(conv);
  switchConv(c);
  historyDlg.close();
}

function deleteConv(c) {
  if (!confirm("この会話の記録を消しますか？（「覚えていること」はそのまま残ります）")) return;
  convs = convs.filter((x) => x !== c);
  if (c === conv) {
    if (state !== "idle") stop();
    switchConv(newConv());
  }
  saveTurns();
  showHistoryList();
}

function formatConv(c) {
  const lines = [`ハヤサポEnglish ${fmtDate(c.startedAt)}${c.scene ? `（${sceneLabel(c.scene)}）` : ""}`, ""];
  for (const t of c.turns) {
    lines.push(`${t.who === "me" ? "自分" : "相手"}: ${t.en}`);
    if (t.ja) lines.push(`　（${t.ja}）`);
  }
  return lines.join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // クリップボードが使えないときは選択状態にして、手でコピーしてもらう
    const range = document.createRange();
    range.selectNodeContents(histText);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    alert("自動でコピーできませんでした。選択された文字を長押ししてコピーしてください");
    return;
  }
  alert("コピーしました");
}

function sceneLabel(scene) {
  if (!scene) return "場面指定なし";
  const sc = SCENES.find((x) => x.en && scene.startsWith(x.en)) || SCENES.find((x) => x.key === OLD_SCENES[scene]);
  return sc ? sc.label : scene.slice(0, 30);
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ===== 覚えていること(過去の会話のメモ) =====
// 会話のうち、まだメモに反映していない発言だけを Claude に渡して、メモを更新する
async function updateMemory(c, { force = false } = {}) {
  const fresh = c.turns.filter((t) => t.id > (c.memUpTo || 0));
  if (memoryBusy || !fresh.length || (!force && fresh.length < MEMORY_MIN_NEW_TURNS)) {
    if (force && !fresh.length) notesStatus.textContent = "新しい発言はありません";
    return;
  }
  if (!passInput.value.trim()) return;
  memoryBusy = true;
  memoryBtn.disabled = true;
  notesStatus.textContent = "覚えていることを更新中…";
  const upTo = fresh[fresh.length - 1].id;
  try {
    await saveNotes(); // 手で書き直した内容を先にサーバーへ(サーバーはそれを元に更新する)
    const res = await api("/api/memory", {
      memory: memoryInput.value.trim(),
      turns: fresh.map((t) => ({ who: t.who, en: t.en })),
      profile: profileInput.value.trim(),
      scene: c.scene || sceneText(),
      date: fmtDate(c.startedAt),
      model: modelSel.value,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.memory) throw new Error(apiErrorMessage(res.status, data, "「覚えていること」の更新"));
    addClaudeUsage(c, data.usage);
    memoryInput.value = data.memory;
    lsSet(LS.memory, data.memory);
    c.memUpTo = upTo;
    saveTurns();
    notesStatus.textContent = `覚えていることを ${fmtDate(Date.now())} に更新しました`;
  } catch (err) {
    notesStatus.textContent = err?.message || String(err);
  } finally {
    memoryBusy = false;
    memoryBtn.disabled = false;
  }
}

function updateEmpty() {
  emptyEl.hidden = turns.length > 0 || !liveEl.hidden;
}

function scrollToBottom(force = false) {
  const near = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 160;
  if (force || near) requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
}

// ===== 画面の状態 =====
function setState(s) {
  state = s;
  dotEl.className = `dot ${s === "idle" ? "" : s}`;
  statusText.textContent = { idle: "停止中", connecting: "接続中…", live: "聞き取り中" }[s];
  toggleBtn.textContent = s === "idle" ? "▶ 開始" : "■ 停止";
  toggleBtn.classList.toggle("stop", s !== "idle");
}

function setMeMode(on) {
  meMode = on;
  meBtn.setAttribute("aria-pressed", String(on));
  meBtn.lastElementChild.textContent = on ? "話し中" : "自分";
  // 話し終わる前に戻したときは、その時点までを自分の発言として区切る
  if (!on && uttFinal.trim()) {
    meMode = true;
    endUtterance();
    meMode = false;
  }
}

function showNotice(text, isError = false) {
  noticeEl.hidden = !text;
  noticeEl.textContent = text;
  noticeEl.classList.toggle("error", isError);
}

function applyShowJa() {
  document.body.classList.toggle("hide-ja", !showJa.checked);
}

function saveSettings() {
  lsSet(LS.pass, passInput.value.trim());
  lsSet(LS.endpoint, endpointSel.value);
  lsSet(LS.showJa, showJa.checked ? "1" : "0");
  lsSet(LS.model, modelSel.value);
  loadNotes();
}

function sceneText() {
  return currentScene().en;
}

function currentScene() {
  return SCENES.find((x) => x.key === sceneKey) || SCENES[0];
}

function migrateScene(old) {
  if (!old) return "";
  return OLD_SCENES[old] || SCENES.find((x) => x.en && x.en === old)?.key || "";
}

function renderSceneBar() {
  sceneBar.replaceChildren(...SCENES.map((sc) => {
    const b = el("button", "scene-chip", sc.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(sc.key === sceneKey));
    b.addEventListener("click", () => {
      sceneKey = sc.key;
      lsSet(LS.scene, sceneKey);
      renderSceneBar();
      // 会話の途中で場面を変えたら、今の会話の場面も変える
      if (turns.length) { conv.scene = sceneText(); saveTurns(); }
    });
    return b;
  }));
  sceneBar.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

// ===== 自己紹介メモ・覚えていること(サーバーに保存) =====
async function loadNotes() {
  if (!passInput.value.trim() || notesDirty) return;
  try {
    const res = await api("/api/notes", {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(res.status, data, "メモの読み込み"));
    if (notesDirty) return;
    // サーバーが空で端末にだけ残っているもの(以前の版の入力)は、サーバーへ移す
    const migrate = {};
    if (!data.profile && profileInput.value.trim()) migrate.profile = profileInput.value;
    if (!data.memory && memoryInput.value.trim()) migrate.memory = memoryInput.value;
    if (data.profile) profileInput.value = data.profile;
    if (data.memory) memoryInput.value = data.memory;
    lsSet(LS.profile, profileInput.value);
    lsSet(LS.memory, memoryInput.value);
    if (Object.keys(migrate).length) await api("/api/notes", { save: migrate });
  } catch (err) {
    notesStatus.textContent = err?.message || String(err);
  }
}

async function saveNotes() {
  clearTimeout(notesTimer);
  lsSet(LS.profile, profileInput.value);
  lsSet(LS.memory, memoryInput.value);
  if (!notesDirty || !passInput.value.trim()) return;
  notesDirty = false;
  try {
    const res = await api("/api/notes", { save: { profile: profileInput.value, memory: memoryInput.value } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(res.status, data, "メモの保存"));
    notesStatus.textContent = "保存しました";
  } catch (err) {
    notesDirty = true;
    notesStatus.textContent = err?.message || String(err);
  }
}

// iOS は画面を離れるとマイクが止まることがある。戻ってきたら確認する
function onVisibility() {
  if (document.visibilityState !== "visible" || state === "idle") return;
  acquireWakeLock();
  audio?.ctx.resume?.().catch(() => {});
  const track = audio?.stream.getAudioTracks()[0];
  if (!track || track.readyState === "ended") stop("画面を離れたためマイクが止まりました。もう一度「開始」を押してください", true);
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
    if (state === "idle") releaseWakeLock();
  } catch { wakeLock = null; }
}
function releaseWakeLock() {
  const wl = wakeLock;
  wakeLock = null;
  wl?.release().catch(() => {});
}

// ===== 通信・保存の小物 =====
function api(path, body, signal) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Passphrase": passInput.value.trim() },
    body: JSON.stringify(body),
    signal,
  });
}

function apiErrorMessage(status, data, what) {
  if (data?.error === "invalid_passphrase") {
    settings.showModal();
    return "合言葉が違います（設定で入力し直してください）";
  }
  if (data?.error === "soniox_not_configured") return "Soniox のキーが未設定です（GitHub Secret に SONIOX_API_KEY を登録してデプロイしてください）";
  if (data?.error === "anthropic_not_configured") return "Claude のキーが未設定です（GitHub Secret に ANTHROPIC_API_KEY を登録してデプロイしてください）";
  return `${what}に失敗しました（${status} ${data?.error || ""} ${data?.message || ""}）`.replace(/\s+）/, "）");
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function validTurns(arr) {
  return Array.isArray(arr) ? arr.filter((t) => t && (t.who === "them" || t.who === "me") && typeof t.en === "string") : [];
}

function loadConvs() {
  let list = [];
  try {
    const arr = JSON.parse(lsGet(LS.convs) || "[]");
    if (Array.isArray(arr)) list = arr.filter((c) => c && typeof c.id === "string").map((c) => ({ ...c, turns: validTurns(c.turns), usage: { ...emptyUsage(), ...(c.usage || {}) } }));
  } catch {}
  // 以前の版(会話が1つだけ)の記録を引き継ぐ
  const old = (() => { try { return validTurns(JSON.parse(lsGet(LS.turns) || "[]")); } catch { return []; } })();
  if (old.length && !list.length) {
    const c = newConv();
    c.turns = old;
    list.push(c);
    lsSet(LS.current, c.id);
  }
  try { localStorage.removeItem(LS.turns); } catch {}
  return list;
}

// 今の会話を含めて保存する(空の会話は残さない。入りきらなければ古い会話から消す)
function saveTurns() {
  conv.updatedAt = Date.now();
  if (turns.length && !convs.includes(conv)) convs.push(conv);
  if (!turns.length && hasUsage(conv) && !convs.includes(conv)) convs.push(conv);
  convs = convs.filter((c) => c.turns.length || hasUsage(c)).sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_CONVS);
  lsSet(LS.current, conv.id);
  for (;;) {
    try {
      localStorage.setItem(LS.convs, JSON.stringify(convs));
      return;
    } catch {
      if (convs.length <= 1) return;
      convs.shift();
    }
  }
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
