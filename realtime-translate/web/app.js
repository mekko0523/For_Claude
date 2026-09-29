"use strict";

// ===== 定数(ここを変えれば挙動を調整できる) =====
const SILENCE_TIMEOUT_MS = 30_000;       // 英語の文字起こしがこの時間届かなければ自動停止
const COUNTDOWN_SHOW_MS = 10_000;        // 残りこの時間になったらカウントダウン表示
const MAX_SESSION_MS = 90 * 60_000;      // 1セッションの最大時間(強制停止)
const PRICE_PER_MIN_USD = 0.034;         // 入力音声 1分あたりの料金
const PARAGRAPH_GAP_MS = 1_500;          // 差分の間隔がこれ以上空いたら改段落
const TICK_MS = 250;

const CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
const LS_PASSPHRASE = "rt.passphrase";
const LS_FONT = "rt.fontScale";

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const elapsedEl = $("elapsed");
const costEl = $("cost");
const noticeEl = $("notice");
const countdownEl = $("countdown");
const enText = $("enText");
const jaText = $("jaText");
const toggleBtn = $("toggleBtn");
const settings = $("settings");
const passInput = $("passphrase");

// ===== 状態 =====
let state = "idle";          // idle | connecting | live
let generation = 0;          // 停止後に古い非同期処理が戻ってきても無視するための世代番号
let pc = null;
let dc = null;
let micStream = null;
let wakeLock = null;
let tickTimer = null;
let liveSince = 0;           // 課金対象(接続完了)の開始時刻
let lastInputAt = 0;         // 最後に英語の文字起こしが届いた時刻
let accumulatedMs = 0;       // 過去セッションを含む累計時間(料金表示用)
let fontScale = 1;

const log = [];              // 書き出し用 {lang, t, text}
const panes = {
  en: { el: enText, p: null, entry: null, lastAt: 0 },
  ja: { el: jaText, p: null, entry: null, lastAt: 0 },
};

// ===== 初期化 =====
$("silenceSec").textContent = SILENCE_TIMEOUT_MS / 1000;
$("maxMin").textContent = MAX_SESSION_MS / 60_000;
passInput.value = lsGet(LS_PASSPHRASE) || "";
passInput.addEventListener("change", () => lsSet(LS_PASSPHRASE, passInput.value.trim()));
applyFontScale(Number(lsGet(LS_FONT)) || 1);

toggleBtn.addEventListener("click", () => (state === "idle" ? start() : stop("user")));
$("settingsBtn").addEventListener("click", () => settings.showModal());
$("fontUp").addEventListener("click", () => applyFontScale(fontScale + 0.1));
$("fontDown").addEventListener("click", () => applyFontScale(fontScale - 0.1));
$("exportBtn").addEventListener("click", exportLog);
$("clearBtn").addEventListener("click", clearSubtitles);
settings.addEventListener("close", () => lsSet(LS_PASSPHRASE, passInput.value.trim()));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state === "live") acquireWakeLock();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
render();

// ===== 開始 =====
async function start() {
  const passphrase = passInput.value.trim();
  if (!passphrase) {
    settings.showModal();
    passInput.focus();
    return;
  }
  const workerUrl = (window.APP_CONFIG?.WORKER_URL || "").replace(/\/$/, "");
  if (!workerUrl || workerUrl.includes("YOUR-SUBDOMAIN")) {
    showNotice("config.js の WORKER_URL を設定してください", true);
    return;
  }

  const gen = ++generation;
  const alive = () => gen === generation;
  setState("connecting");
  showNotice("");
  lastInputAt = Date.now();
  startTicking();
  acquireWakeLock();

  try {
    // 1) client secret 取得
    const res = await fetch(`${workerUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.value) {
      if (data.error === "invalid_passphrase") throw new Error("合言葉が違います");
      throw new Error(`client secret の取得に失敗 (${res.status} ${data.error || ""})`);
    }
    if (!alive()) return;

    // 2) マイク
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!alive()) { stream.getTracks().forEach((t) => t.stop()); return; }
    micStream = stream;

    // 3) WebRTC
    pc = new RTCPeerConnection();
    const thisPc = pc;
    // 翻訳音声は届くが再生しない(要素に接続しないので鳴らない)
    thisPc.ontrack = () => {};
    thisPc.onconnectionstatechange = () => {
      if (!alive()) return;
      const s = thisPc.connectionState;
      if (s === "failed" || s === "disconnected") stop("error", "接続が切断されました");
    };
    for (const track of stream.getAudioTracks()) thisPc.addTrack(track, stream);

    dc = thisPc.createDataChannel("oai-events");
    dc.onopen = () => {
      if (!alive()) return;
      liveSince = Date.now();
      lastInputAt = liveSince; // 開始時点から無音カウント
      setState("live");
      markSessionStart();
    };
    dc.onmessage = (e) => { if (alive()) handleEvent(e.data); };
    dc.onclose = () => { if (alive() && state !== "idle") stop("error", "サーバーとの接続が閉じられました"); };

    const offer = await thisPc.createOffer();
    await thisPc.setLocalDescription(offer);
    if (!alive()) return;

    const sdpRes = await fetch(CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${data.value}`, "Content-Type": "application/sdp" },
    });
    const answer = await sdpRes.text();
    if (!sdpRes.ok) throw new Error(`WebRTC 接続に失敗 (${sdpRes.status}) ${answer.slice(0, 200)}`);
    if (!alive()) return;
    await thisPc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (err) {
    if (!alive()) return;
    const msg = err?.name === "NotAllowedError"
      ? "マイクの使用が許可されていません(設定 > Safari > マイク)"
      : err?.message || String(err);
    stop("error", msg);
  }
}

// ===== 停止 =====
function stop(reason, message) {
  generation++; // 進行中の非同期処理を無効化
  if (liveSince) accumulatedMs += Date.now() - liveSince;
  liveSince = 0;

  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  dc = null; pc = null; micStream = null;
  releaseWakeLock();
  stopTicking();
  countdownEl.hidden = true;
  setState("idle");

  if (reason === "silence") {
    showNotice(`無音が${SILENCE_TIMEOUT_MS / 1000}秒続いたため停止しました`);
    statusEl.textContent = "自動停止";
  } else if (reason === "max") {
    showNotice(`最長時間(${MAX_SESSION_MS / 60_000}分)に達したため停止しました`);
    statusEl.textContent = "自動停止";
  } else if (reason === "error") {
    statusEl.dataset.state = "error";
    statusEl.textContent = "エラー";
    showNotice(message || "エラーが発生しました", true);
  } else {
    showNotice("");
  }
  render();
}

// ===== 受信イベント =====
function handleEvent(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  switch (ev.type) {
    case "session.input_transcript.delta":
      lastInputAt = Date.now();
      appendDelta("en", ev.delta);
      break;
    case "session.output_transcript.delta":
      appendDelta("ja", ev.delta);
      break;
    case "session.closed":
      stop("error", "セッションがサーバー側で終了しました");
      break;
    case "error":
      stop("error", ev.error?.message || "サーバーからエラーが返されました");
      break;
  }
}

function appendDelta(lang, delta) {
  if (!delta) return;
  const pane = panes[lang];
  const now = Date.now();
  const nearBottom = pane.el.scrollHeight - pane.el.scrollTop - pane.el.clientHeight < 60;

  if (!pane.p || now - pane.lastAt > PARAGRAPH_GAP_MS) {
    pane.p = document.createElement("p");
    pane.el.appendChild(pane.p);
    pane.entry = { lang, t: now, text: "" };
    log.push(pane.entry);
    delta = delta.replace(/^\s+/, "");
  }
  pane.lastAt = now;
  pane.entry.text += delta;
  pane.p.textContent = pane.entry.text;

  // ユーザーが読み返しているとき以外は自動スクロール
  if (nearBottom) pane.el.scrollTop = pane.el.scrollHeight;
}

function markSessionStart() {
  // 2回目以降の開始では区切り線代わりに段落を切る
  for (const pane of Object.values(panes)) { pane.p = null; pane.entry = null; }
}

// ===== タイマー(経過時間・料金・無音判定) =====
function startTicking() {
  stopTicking();
  tickTimer = setInterval(tick, TICK_MS);
}
function stopTicking() {
  clearInterval(tickTimer);
  tickTimer = null;
}
function tick() {
  const now = Date.now();
  if (state !== "idle") {
    const silentFor = now - lastInputAt;
    const remaining = SILENCE_TIMEOUT_MS - silentFor;
    if (remaining <= 0) {
      return state === "live" ? stop("silence") : stop("error", "接続がタイムアウトしました");
    }
    if (liveSince && now - liveSince >= MAX_SESSION_MS) return stop("max");
    if (state === "live" && remaining <= COUNTDOWN_SHOW_MS) {
      countdownEl.hidden = false;
      countdownEl.textContent = `無音のため ${Math.ceil(remaining / 1000)} 秒後に停止します`;
    } else {
      countdownEl.hidden = true;
    }
  }
  render();
}

function render() {
  const sessionMs = liveSince ? Date.now() - liveSince : 0;
  const shown = liveSince ? sessionMs : accumulatedMs;
  elapsedEl.textContent = fmtTime(shown);
  costEl.textContent = `$${((accumulatedMs + sessionMs) / 60_000 * PRICE_PER_MIN_USD).toFixed(3)}`;
  costEl.title = "このページを開いてからの累計概算";
  toggleBtn.textContent = state === "idle" ? "開始" : "停止";
  toggleBtn.classList.toggle("stop", state !== "idle");
}

function setState(s) {
  state = s;
  statusEl.dataset.state = s;
  statusEl.textContent = { idle: "待機中", connecting: "接続中…", live: "翻訳中" }[s];
  render();
}

// ===== Wake Lock =====
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

// ===== 表示・設定 =====
function showNotice(msg, isError = false) {
  noticeEl.hidden = !msg;
  noticeEl.textContent = msg;
  noticeEl.classList.toggle("error", isError);
}

function applyFontScale(v) {
  fontScale = Math.min(2, Math.max(0.7, Math.round(v * 10) / 10));
  document.documentElement.style.setProperty("--en-size", `${17 * fontScale}px`);
  document.documentElement.style.setProperty("--ja-size", `${26 * fontScale}px`);
  lsSet(LS_FONT, String(fontScale));
}

function clearSubtitles() {
  if (!confirm("表示中の字幕をすべて消去しますか?")) return;
  enText.textContent = "";
  jaText.textContent = "";
  log.length = 0;
  for (const pane of Object.values(panes)) { pane.p = null; pane.entry = null; }
}

function exportLog() {
  if (!log.length) { alert("保存する字幕がありません"); return; }
  const lines = [...log]
    .sort((a, b) => a.t - b.t)
    .map((e) => `[${new Date(e.t).toLocaleTimeString("ja-JP")}] ${e.lang.toUpperCase()}: ${e.text}`);
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `subtitles-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
