"use strict";

// ===== 定数(ここを変えれば挙動を調整できる) =====
const SILENCE_TIMEOUT_MS = 30_000;       // 英語の文字起こしがこの時間届かなければ自動停止
const COUNTDOWN_SHOW_MS = 10_000;        // 残りこの時間になったらカウントダウン表示
const MAX_SESSION_MS = 90 * 60_000;      // 1セッションの最大時間(強制停止)
const PRICE_PER_MIN_USD = 0.034;         // 入力音声 1分あたりの料金
const PARAGRAPH_GAP_MS = 1_500;          // 差分の間隔がこれ以上空いたら改段落
const TICK_MS = 250;
// マイクは OS 標準の設定で取得する。iOS Safari では echoCancellation:false などを指定すると
// 無音しか送られないことがあるため、公式サンプルと同じ { audio: true } にする。
const MIC_CONSTRAINTS = true;
const STATS_INTERVAL_MS = 500;           // 送信音量の取得間隔
const STATS_LOG_MS = 5_000;              // 診断ログに送信状況を書く間隔
const SPEND_LIMIT_MSG = "今月の利用上限に達しました(OpenAI の月間上限)。来月まで利用できません";

const CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
const LS_PASSPHRASE = "rt.passphrase";
const LS_FONT = "rt.fontScale";
const LS_SESSIONS = "rt.sessions";        // セッション一覧(目次)
const LS_SESSION_PREFIX = "rt.session.";  // 各セッションの字幕本体
const LS_CURRENT = "rt.currentSession";
const AUTOSAVE_MS = 2_000;                // 字幕の自動保存間隔

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
const diagEl = $("diag");
const micBar = $("micBar");
const diagCount = $("diagCount");
const diagLogEl = $("diagLog");

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
let session = null;          // 表示中のセッション {id, createdAt, updatedAt, durationMs, entries}
let dirty = false;           // 未保存の字幕があるか
let lastSaveAt = 0;
let storageWarned = false;
let fontScale = 1;
let lastError = "";          // 手動停止しても消さずに残すエラー
let statsTimer = null;       // 送信音量(WebRTC 統計)の取得
let lastStatsLogAt = 0;
let remoteAudio = null;      // 翻訳音声(ミュートで受けるだけ)
let eventCount = 0;
let lastEventType = "";
const diagLines = [];        // 診断ログ(設定画面に表示・コピー可)
const DIAG_MAX = 80;

const panes = {
  en: { el: enText, p: null, entry: null, lastAt: 0 },
  ja: { el: jaText, p: null, entry: null, lastAt: 0 },
};

// ===== 初期化 =====
$("silenceSec").textContent = SILENCE_TIMEOUT_MS / 1000;
$("maxMin").textContent = MAX_SESSION_MS / 60_000;
passInput.value = loadPassphrase();
passInput.addEventListener("input", () => savePassphrase(passInput.value));
passInput.addEventListener("change", () => savePassphrase(passInput.value));
// iOS に保存データを消さないよう依頼(対応ブラウザのみ)
navigator.storage?.persist?.().catch(() => {});
applyFontScale(Number(lsGet(LS_FONT)) || 1);

toggleBtn.addEventListener("click", () => (state === "idle" ? start() : stop("user")));
$("settingsBtn").addEventListener("click", () => settings.showModal());
$("fontUp").addEventListener("click", () => applyFontScale(fontScale + 0.1));
$("fontDown").addEventListener("click", () => applyFontScale(fontScale - 0.1));
$("newBtn").addEventListener("click", newSession);
$("saveBtn").addEventListener("click", () => shareSession(session));
$("historyBtn").addEventListener("click", openHistory);
$("copyDiagBtn").addEventListener("click", copyDiag);
$("settingsBtn").addEventListener("click", renderDiagLog);
settings.addEventListener("close", () => savePassphrase(passInput.value));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state === "live") acquireWakeLock();
  if (document.visibilityState === "hidden") saveSession();
});
window.addEventListener("pagehide", () => saveSession());

// 前回表示していたセッションを復元
session = loadSession(lsGet(LS_CURRENT)) || createSession();
renderSession();

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
    showNotice("Worker の URL が未設定です(GitHub Actions のデプロイを確認してください)", true);
    return;
  }

  const gen = ++generation;
  const alive = () => gen === generation;
  setState("connecting");
  showNotice("");
  lastError = "";
  eventCount = 0;
  lastEventType = "";
  diagEl.hidden = false;
  diag(`開始 ${navigator.userAgent}`);
  // 翻訳音声の受け皿(iOS で WebRTC の音声経路を確実に動かすため。ミュートなので鳴らない)
  remoteAudio = new Audio();
  remoteAudio.muted = true;
  remoteAudio.autoplay = true;
  remoteAudio.setAttribute("playsinline", "");
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
      if (data.error === "spend_limit_exceeded" || isSpendLimit(data.status, data.detail)) {
        throw new Error(SPEND_LIMIT_MSG);
      }
      if (data.error === "forbidden_origin") throw new Error("このページのアドレスは Worker で許可されていません");
      const detail = data.detail?.message ? `: ${data.detail.message}` : "";
      throw new Error(`client secret の取得に失敗 (${res.status} ${data.error || ""})${detail}`);
    }
    savePassphrase(passphrase); // 通った合言葉は確実に保存
    if (!alive()) return;

    // 2) マイク
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("このブラウザはマイクに対応していません(Safari で開いてください)");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    if (!alive()) { stream.getTracks().forEach((t) => t.stop()); return; }
    micStream = stream;
    const track = stream.getAudioTracks()[0];
    diag(`マイク取得: ${track?.label || "(名前なし)"} muted=${track?.muted} state=${track?.readyState} ${JSON.stringify(track?.getSettings?.() || {})}`);
    track?.addEventListener("mute", () => diag("マイクトラック mute(iOS がマイクを止めた可能性)"));
    track?.addEventListener("unmute", () => diag("マイクトラック unmute"));
    track?.addEventListener("ended", () => diag("マイクトラック ended"));

    // 3) WebRTC
    pc = new RTCPeerConnection();
    const thisPc = pc;
    // 翻訳音声は届くが再生しない(要素に接続しないので鳴らない)
    thisPc.ontrack = ({ streams }) => {
      if (!remoteAudio) return;
      remoteAudio.srcObject = streams[0];
      remoteAudio.play?.().catch(() => {});
    };
    thisPc.onconnectionstatechange = () => {
      if (!alive()) return;
      const s = thisPc.connectionState;
      diag(`WebRTC: ${s}`);
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
      diag("データチャネル接続");
      startStats(thisPc);
    };
    dc.onmessage = (e) => { if (alive()) handleEvent(e.data); };
    dc.onclose = () => { diag("データチャネル切断"); if (alive() && state !== "idle") stop("error", "サーバーとの接続が閉じられました"); };

    const offer = await thisPc.createOffer();
    await thisPc.setLocalDescription(offer);
    if (!alive()) return;

    const sdpRes = await fetch(CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${data.value}`, "Content-Type": "application/sdp" },
    });
    const answer = await sdpRes.text();
    if (!sdpRes.ok) {
      let err = null;
      try { err = JSON.parse(answer).error; } catch {}
      if (isSpendLimit(sdpRes.status, err)) throw new Error(SPEND_LIMIT_MSG);
      throw new Error(`WebRTC 接続に失敗 (${sdpRes.status}) ${err?.message || answer.slice(0, 200)}`);
    }
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
  if (liveSince) session.durationMs += Date.now() - liveSince;
  liveSince = 0;
  saveSession();

  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  dc = null; pc = null; micStream = null;
  stopStats();
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio = null; }
  diag(`停止: ${reason}${message ? ` / ${message}` : ""} (受信 ${eventCount} 件)`);
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
  } else if (lastError) {
    // セッション中に出たエラーは手動停止しても残す
    showNotice(lastError, true);
  } else if (reason === "user" && eventCount <= 1) {
    showNotice("字幕イベントを受信できませんでした。⚙︎ の診断ログを確認してください", true);
  } else {
    showNotice("");
  }
  render();
}

// ===== 受信イベント =====
function handleEvent(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { diag(`JSON 以外を受信: ${String(raw).slice(0, 120)}`); return; }
  eventCount++;
  const type = String(ev.type || "");
  if (type !== lastEventType) {
    // 同じ種類の連続(delta など)は1行にまとめる
    diag(type.endsWith(".delta") ? `受信: ${type}` : `受信: ${type} ${JSON.stringify(ev).slice(0, 300)}`);
    lastEventType = type;
  }
  switch (type) {
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
      if (isSpendLimit(429, ev.error)) {
        stop("error", SPEND_LIMIT_MSG);
      } else {
        // 致命的でないエラーもあるので接続は維持する(本当に切れた場合は dc/pc のイベントで停止する)
        lastError = `サーバーエラー: ${ev.error?.message || ev.error?.code || "不明"}`;
        showNotice(lastError, true);
      }
      break;
    default:
      // イベント名が想定と違っても字幕を出せるよう、名前のパターンで振り分ける
      if (/delta$/.test(type) && !/audio\.delta$/.test(type) && typeof ev.delta === "string") {
        if (/input|source/.test(type)) { lastInputAt = Date.now(); appendDelta("en", ev.delta); }
        else appendDelta("ja", ev.delta);
      }
  }
}

// OpenAI のプロジェクト月間上限(429 project_spend_limit_exceeded など)
function isSpendLimit(status, err) {
  if (status !== 429 || !err) return false;
  const text = `${err.code ?? ""} ${err.type ?? ""} ${err.message ?? ""}`;
  return /spend_limit|insufficient_quota|billing|quota/i.test(text);
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
    session.entries.push(pane.entry);
    delta = delta.replace(/^\s+/, "");
  }
  pane.lastAt = now;
  pane.entry.text += delta;
  pane.p.textContent = pane.entry.text;
  dirty = true;

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
  if (dirty && now - lastSaveAt >= AUTOSAVE_MS) saveSession();
  render();
}

// ===== 診断 =====
function diag(msg) {
  const t = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  diagLines.push(`${t} ${msg}`);
  if (diagLines.length > DIAG_MAX) diagLines.shift();
  if (settings.open) renderDiagLog();
}
function renderDiagLog() {
  diagLogEl.textContent = diagLines.length ? diagLines.join("\n") : "(まだありません)";
}
async function copyDiag() {
  const text = diagLines.join("\n");
  try { await navigator.clipboard.writeText(text); alert("診断ログをコピーしました"); }
  catch { prompt("コピーしてください", text); }
}

// 実際に OpenAI へ送っている音声の音量を WebRTC 統計から取る(AudioContext は iOS の録音を妨げることがあるため使わない)
function startStats(peer) {
  stopStats();
  lastStatsLogAt = Date.now();
  statsTimer = setInterval(async () => {
    let level = null, bytesSent = null, packetsSent = null;
    try {
      const report = await peer.getStats();
      report.forEach((r) => {
        if (r.type === "media-source" && r.kind === "audio" && typeof r.audioLevel === "number") level = r.audioLevel;
        if (r.type === "outbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) {
          bytesSent = r.bytesSent; packetsSent = r.packetsSent;
        }
      });
    } catch { return; }
    if (level !== null) setMeter(level);
    if (Date.now() - lastStatsLogAt >= STATS_LOG_MS) {
      lastStatsLogAt = Date.now();
      diag(`送信: ${bytesSent ?? "?"} bytes / ${packetsSent ?? "?"} packets / 音量 ${level === null ? "取得不可" : level.toFixed(3)}`);
    }
  }, STATS_INTERVAL_MS);
}
function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  meterLevel = 0;
  micBar.style.width = "0%";
}
let meterLevel = 0;
function setMeter(level) {
  // audioLevel(0〜1)を dB 換算して -60dB〜0dB を 0〜100% に
  const db = 20 * Math.log10(level || 1e-8);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meterLevel = Math.max(pct, meterLevel * 0.7);
  micBar.style.width = `${meterLevel}%`;
}

function render() {
  diagCount.textContent = `受信 ${eventCount} 件`;
  // 経過時間と料金は「表示中のセッション」の合計
  const totalMs = (session?.durationMs || 0) + (liveSince ? Date.now() - liveSince : 0);
  elapsedEl.textContent = fmtTime(totalMs);
  costEl.textContent = `$${(totalMs / 60_000 * PRICE_PER_MIN_USD).toFixed(3)}`;
  costEl.title = "このセッションの概算料金";
  toggleBtn.textContent = state === "idle" ? (session?.entries.length ? "再開" : "開始") : "停止";
  toggleBtn.classList.toggle("stop", state !== "idle");
  $("newBtn").disabled = state !== "idle";
  $("historyBtn").disabled = state !== "idle";
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

// ===== セッション(字幕の保存・切り替え) =====
function createSession() {
  const now = Date.now();
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  lsSet(LS_CURRENT, id);
  return { id, createdAt: now, updatedAt: now, durationMs: 0, entries: [] };
}

function loadSession(id) {
  if (!id) return null;
  try {
    const obj = JSON.parse(lsGet(LS_SESSION_PREFIX + id));
    return obj && Array.isArray(obj.entries) ? obj : null;
  } catch { return null; }
}

function loadIndex() {
  try { return JSON.parse(lsGet(LS_SESSIONS)) || []; } catch { return []; }
}

// 字幕が1行もないセッションは一覧に載せない
function saveSession() {
  lastSaveAt = Date.now();
  dirty = false;
  if (!session || (!session.entries.length && !session.durationMs)) return;
  session.updatedAt = Date.now();
  const firstEn = session.entries.find((e) => e.lang === "en")?.text || "";
  const meta = {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    durationMs: session.durationMs,
    preview: firstEn.slice(0, 60),
  };
  const index = loadIndex().filter((m) => m.id !== session.id);
  index.unshift(meta);
  index.sort((a, b) => b.createdAt - a.createdAt);
  const ok = lsSet(LS_SESSION_PREFIX + session.id, JSON.stringify(session)) && lsSet(LS_SESSIONS, JSON.stringify(index));
  if (!ok && !storageWarned) {
    storageWarned = true;
    showNotice("端末の保存容量が足りず、字幕を保存できませんでした。履歴から古いセッションを削除してください", true);
  }
}

function renderSession() {
  enText.textContent = "";
  jaText.textContent = "";
  for (const e of session.entries) {
    const p = document.createElement("p");
    p.textContent = e.text;
    (e.lang === "en" ? enText : jaText).appendChild(p);
  }
  for (const pane of Object.values(panes)) {
    pane.p = null;
    pane.entry = null;
    pane.el.scrollTop = pane.el.scrollHeight;
  }
  lsSet(LS_CURRENT, session.id);
  render();
}

function newSession() {
  if (state !== "idle") return;
  if (!session.entries.length) { showNotice("新しいセッションです"); return; }
  saveSession();
  session = createSession();
  renderSession();
  showNotice("新しいセッションを開始しました。前のセッションは「履歴」に保存されています");
}

function switchSession(id) {
  if (state !== "idle") return;
  const target = loadSession(id);
  if (!target) { alert("このセッションを読み込めませんでした"); return; }
  saveSession();
  session = target;
  renderSession();
  $("history").close();
  showNotice(`${fmtDateTime(session.createdAt)} のセッションを表示中。「再開」で続きを翻訳できます`);
}

function deleteSession(id) {
  if (!confirm("このセッションの字幕を削除しますか?(元に戻せません)")) return;
  try { localStorage.removeItem(LS_SESSION_PREFIX + id); } catch {}
  lsSet(LS_SESSIONS, JSON.stringify(loadIndex().filter((m) => m.id !== id)));
  if (session.id === id) {
    session = createSession();
    renderSession();
  }
  openHistory();
}

function openHistory() {
  if (state !== "idle") return;
  saveSession();
  const list = $("historyList");
  list.textContent = "";
  const index = loadIndex();
  if (!index.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "保存されたセッションはまだありません";
    list.appendChild(li);
  }
  for (const m of index) {
    const li = document.createElement("li");
    if (m.id === session.id) li.classList.add("current");
    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `${fmtDateTime(m.createdAt)}(${m.durationMs < 60_000 ? "1分未満" : `${Math.round(m.durationMs / 60_000)}分`})${m.id === session.id ? " ・表示中" : ""}`;
    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = m.preview || "(英語なし)";
    info.append(title, preview);
    const btns = document.createElement("div");
    btns.className = "btns";
    btns.append(
      mkBtn("開く", () => switchSession(m.id)),
      mkBtn("保存", () => { const s2 = loadSession(m.id); if (s2) shareSession(s2); }),
      mkBtn("削除", () => deleteSession(m.id), "danger"),
    );
    li.append(info, btns);
    list.appendChild(li);
  }
  if (!$("history").open) $("history").showModal();
}

function mkBtn(label, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `small-btn ${cls}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// 英語・日本語それぞれの全文と、時刻順の対訳をまとめたテキスト
function sessionToText(sess) {
  const entries = [...sess.entries].sort((a, b) => a.t - b.t);
  const time = (t) => new Date(t).toLocaleTimeString("ja-JP", { hour12: false });
  const join = (lang) => entries.filter((e) => e.lang === lang).map((e) => e.text.trim()).filter(Boolean).join("\n");
  return [
    `英日字幕 ${fmtDateTime(sess.createdAt)}(翻訳時間 ${fmtTime(sess.durationMs)})`,
    "",
    "■ 英語原文",
    join("en") || "(なし)",
    "",
    "■ 日本語訳",
    join("ja") || "(なし)",
    "",
    "■ 対訳(時刻順)",
    ...entries.map((e) => `[${time(e.t)}] ${e.lang === "en" ? "EN" : "JA"}: ${e.text.trim()}`),
    "",
  ].join("\n");
}

async function shareSession(sess) {
  if (!sess?.entries.length) { alert("保存する字幕がありません"); return; }
  const d = new Date(sess.createdAt);
  const pad = (n) => String(n).padStart(2, "0");
  const name = `subtitles_en-ja_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  const file = new File([sessionToText(sess)], name, { type: "text/plain" });
  // iPhone では共有シートから「ファイルに保存」「メモ」「AirDrop」などを選べる
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fmtDateTime(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 合言葉は localStorage と Cookie の両方に保存し、片方が消えても復元する
function loadPassphrase() {
  const fromLs = lsGet(LS_PASSPHRASE);
  if (fromLs) return fromLs;
  const m = document.cookie.match(/(?:^|; )rt_pass=([^;]*)/);
  const fromCookie = m ? decodeURIComponent(m[1]) : "";
  if (fromCookie) lsSet(LS_PASSPHRASE, fromCookie);
  return fromCookie;
}
function savePassphrase(v) {
  v = (v || "").trim();
  if (!v) return;
  lsSet(LS_PASSPHRASE, v);
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `rt_pass=${encodeURIComponent(v)}; Max-Age=34560000; Path=/; SameSite=Strict${secure}`;
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
