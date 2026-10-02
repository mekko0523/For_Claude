"use strict";

// ===== 定数(ここを変えれば挙動を調整できる) =====
const SILENCE_TIMEOUT_MS = 3 * 60_000;   // 話し声の文字起こしがこの時間届かなければ自動停止(待機時間)
const COUNTDOWN_SHOW_MS = 30_000;        // 残りこの時間になったらカウントダウン表示
const CONNECT_TIMEOUT_MS = 30_000;       // 接続がこの時間で完了しなければエラー
const MAX_SESSION_MS = 90 * 60_000;      // 1セッションの最大時間(強制停止)
const PRICE_PER_MIN_USD = 0.034;         // 入力音声 1分あたりの料金
const PARAGRAPH_GAP_MS = 1_500;          // 差分の間隔がこれ以上空いたら改段落
const TICK_MS = 250;
// マイクは OS 標準の設定で取得する。iOS Safari では echoCancellation:false などを指定すると
// 無音しか送られないことがあるため、公式サンプルと同じ { audio: true } にする。
const MIC_CONSTRAINTS = true;
const STATS_INTERVAL_MS = 500;           // 送信音量の取得間隔
const STATS_LOG_MS = 5_000;              // 診断ログに送信状況を書く間隔
const SILENT_MIC_MS = 6_000;             // この間ずっと音量ゼロならマイク不調とみなす
const SILENT_LEVEL = 0.0005;             // 静かな部屋でも通常はこれ以上の音量がある
const QUIET_CHECK_MS = 8_000;            // 英語が届かないままこの時間たったら音量を確認
const QUIET_LEVEL = 0.02;                // 認識できた会話の音量は 0.03〜0.06 程度だった
const SPEND_LIMIT_MSG = "今月の利用上限に達しました(OpenAI の月間上限)。来月まで利用できません";

const CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
// 日本語の文字起こしモード
const TX_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const LS_MODE = "rt.mode";
// 区切り(commit)は音量で「話し終わり」を判定して送る(公式推奨のクライアント側 VAD)。
// 文の途中で区切ると前後の文脈が失われて誤認識が増えるため、間(ま)ができたときだけ区切る
const VAD_PAUSE_MS = 900;                // 話し声のあと、この時間静かなら区切る
const VAD_MIN_SPEECH_THRESHOLD = 0.02;   // 話し声とみなす最小の音量
const TX_COMMIT_SOFT_MAX_MS = 30_000;    // 話し続けていても、この時間を過ぎたら次の小さな間で区切る
const TX_COMMIT_HARD_MAX_MS = 45_000;    // それでも区切れなければこの時間で必ず区切る
const TX_FALLBACK_PAUSE_MS = 3_000;      // 音量が取れない端末では文字の途切れで区切る
const LS_TX_DELAY = "rt.txDelay";
const LS_PASSPHRASE = "rt.passphrase";
const LS_FONT = "rt.fontScale";
const LS_BOOST = "rt.micBoost";
const LS_GLOSSARY = "rt.glossary";
const LS_RECORD = "rt.recordAudio";
// 録音(話者分け用)。端末内(IndexedDB)にだけ保存し、要約時に Worker 経由で OpenAI へ送る
const REC_BITRATE = 32_000;              // 1時間で約15MB(OpenAI の上限は1ファイル25MB)
const REC_ROTATE_MS = 20 * 60_000;       // 長い録音は20分ごとに別ファイルに分ける
const REC_KEEP_DAYS = 14;                // これより古い録音は自動で削除
// 集音ブースト: 送る前にアプリ内で音量を上げる(コンプレッサーで音割れを防ぐ)
const BOOST_GAIN = { off: 1, normal: 3, strong: 6 };
const DEFAULT_GLOSSARY = `# 1行に「誤り → 正しい」の形で書きます(英語・日本語どちらも可)
# 字幕の表示と保存テキストで自動的に置き換わります。# で始まる行は無視されます
# 矢印なしで単語だけ書くと、日本語の文字起こしで聞き取ってほしいキーワードになります
グリフォサート → グリホサート
パラクアット → パラコート
クロルピリフォス → クロルピリホス
イミダクロプリッド → イミダクロプリド
`;
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
let micCheckSince = 0;       // 無音マイク判定の起点
let micMaxLevel = 0;         // 判定期間中の最大音量
let boostCtx = null;         // 集音ブースト用 AudioContext
let rawMicTrack = null;      // ブースト前の生のマイク
let enCount = 0, jaCount = 0;
let lastEnAt = 0, lastJaAt = 0;
let enStallHandled = false;  // 英語だけ止まったときの対処を済ませたか
const EN_STALL_MS = 15_000;  // 日本語訳は届くのに英語がこの時間来なければ対処する
let glossaryRules = [];      // [{from: RegExp|string, to}]
let glossaryKeywords = [];   // 文字起こしモードでモデルに渡すキーワード
let txModel = "";            // 文字起こしモードで実際に使われたモデル
let lastCommitAt = 0;
let lastTxDeltaAt = 0;
let txDeltasSinceCommit = 0;
let vadNoise = 0.01;         // 周囲の雑音レベル(自動で追従)
let vadLastLoudAt = 0;
let vadSpeechSinceCommit = false;
let vadLevelSeen = false;    // 音量が取れているか
const txItems = new Map();   // item_id → {entry, p}
let micRecoveries = 0;       // マイク再取得を試みた回数
let quietCheckSince = 0;     // 「音が小さい」判定の起点(英語が届いたら 0)
let quietMaxLevel = 0;
let inputSeen = false;       // この接続で英語の文字起こしが届いたか
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
$("silenceSec").textContent = fmtDuration(SILENCE_TIMEOUT_MS);
$("maxMin").textContent = MAX_SESSION_MS / 60_000;
passInput.value = loadPassphrase();
passInput.addEventListener("input", () => savePassphrase(passInput.value));
passInput.addEventListener("change", () => savePassphrase(passInput.value));
// iOS に保存データを消さないよう依頼(対応ブラウザのみ)
navigator.storage?.persist?.().catch(() => {});
applyFontScale(Number(lsGet(LS_FONT)) || 1);
const txDelaySel = $("txDelay");
txDelaySel.value = ["low", "medium", "high"].includes(lsGet(LS_TX_DELAY)) ? lsGet(LS_TX_DELAY) : "medium";
txDelaySel.addEventListener("change", () => lsSet(LS_TX_DELAY, txDelaySel.value));
const boostSel = $("micBoost");
boostSel.value = BOOST_GAIN[lsGet(LS_BOOST)] ? lsGet(LS_BOOST) : "normal";
boostSel.addEventListener("change", () => lsSet(LS_BOOST, boostSel.value));
const recordEl = $("recordAudio");
recordEl.checked = lsGet(LS_RECORD) !== "off";
recordEl.addEventListener("change", () => lsSet(LS_RECORD, recordEl.checked ? "on" : "off"));
pruneRecordings();
const glossaryEl = $("glossary");
glossaryEl.value = lsGet(LS_GLOSSARY) ?? DEFAULT_GLOSSARY;
compileGlossary();
glossaryEl.addEventListener("input", () => {
  lsSet(LS_GLOSSARY, glossaryEl.value);
  compileGlossary();
  if (state === "idle" && session) renderSession();
});
glossaryEl.addEventListener("change", () => buildGlossaryUI());

toggleBtn.addEventListener("click", () => (state === "idle" ? start() : stop("user")));
$("settingsBtn").addEventListener("click", () => settings.showModal());
$("fontUp").addEventListener("click", () => applyFontScale(fontScale + 0.1));
$("fontDown").addEventListener("click", () => applyFontScale(fontScale - 0.1));
$("newBtn").addEventListener("click", newSession);
$("saveBtn").addEventListener("click", () => openShare(session));
for (const b of document.querySelectorAll(".mode-switch button")) {
  b.addEventListener("click", () => switchMode(b.dataset.mode));
}
$("summarizeBtn").addEventListener("click", generateSummary);
$("shareSummaryBtn").addEventListener("click", shareSummary);
$("shareFullBtn").addEventListener("click", () => shareSession(shareTarget));
$("summaryText").addEventListener("input", () => {
  if (!shareTarget) return;
  shareTarget.summary = $("summaryText").value;
  persistSession(shareTarget);
});
$("historyBtn").addEventListener("click", openHistory);
$("glossaryBtn").addEventListener("click", openGlossary);
$("addRuleBtn").addEventListener("click", () => { addTermRow("rule"); });
$("addKeywordBtn").addEventListener("click", () => { addTermRow("keyword"); });
$("cleanBtn").addEventListener("click", () => cleanSession(shareTarget));
$("viewCleanBtn").addEventListener("click", () => setCleanView(shareTarget, true));
$("viewLiveBtn").addEventListener("click", () => setCleanView(shareTarget, false));
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
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    showNotice("Worker の URL が未設定です(GitHub Actions のデプロイを確認してください)", true);
    return;
  }

  if (session.showClean) { session.showClean = false; renderSession(); } // 続きはリアルタイム版に追記する
  const gen = ++generation;
  const alive = () => gen === generation;
  setState("connecting");
  showNotice("");
  lastError = "";
  micRecoveries = 0;
  micCheckSince = 0;
  inputSeen = false;
  quietCheckSince = 0;
  quietMaxLevel = 0;
  eventCount = 0;
  enCount = 0; jaCount = 0;
  lastEnAt = 0; lastJaAt = 0;
  enStallHandled = false;
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
      body: JSON.stringify(isTx()
        ? { passphrase, mode: "transcribe", keywords: glossaryKeywords, delay: $("txDelay").value }
        : { passphrase }),
    });
    const data = await res.json().catch(() => ({}));
    if (isTx() && data.value) {
      txModel = data.model || "";
      diag(`文字起こしモデル: ${txModel}${data.delay ? ` / delay=${data.delay}` : ""}${data.fallback ? `(最初の設定は不可: ${data.firstError || "?"})` : ""}`);
    }
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
    watchMicTrack(track);

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
    const sendTrack = (await buildBoostedTrack(stream)) || track;
    if (!alive()) return;
    thisPc.addTrack(sendTrack, new MediaStream([sendTrack]));
    const recordTrack = sendTrack;
    rawMicTrack = track;

    dc = thisPc.createDataChannel("oai-events");
    dc.onopen = () => {
      if (!alive()) return;
      liveSince = Date.now();
      lastInputAt = liveSince; // 開始時点から無音カウント
      setState("live");
      markSessionStart();
      diag("データチャネル接続");
      quietCheckSince = Date.now();
      startStats(thisPc);
      startRecorder(recordTrack);
    };
    dc.onmessage = (e) => { if (alive()) handleEvent(e.data); };
    dc.onclose = () => { diag("データチャネル切断"); if (alive() && state !== "idle") stop("error", "サーバーとの接続が閉じられました"); };

    const offer = await thisPc.createOffer();
    await thisPc.setLocalDescription(offer);
    if (!alive()) return;

    const sdpRes = await fetch(isTx() ? TX_CALLS_URL : CALLS_URL, {
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

  stopRecorder(); // マイクを止める前に録音を確定させる
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  closeBoost();
  dc = null; pc = null; micStream = null;
  stopStats();
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio = null; }
  diag(`停止: ${reason}${message ? ` / ${message}` : ""} (受信 ${eventCount} 件)`);
  releaseWakeLock();
  stopTicking();
  countdownEl.hidden = true;
  setState("idle");

  if (reason === "silence") {
    showNotice(`無音が${fmtDuration(SILENCE_TIMEOUT_MS)}続いたため停止しました`);
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
      noteInput();
      enCount++;
      lastEnAt = Date.now();
      appendDelta("en", ev.delta);
      break;
    case "session.output_transcript.delta":
      // 英語の文字起こしが止まっても、訳が届いている間は会話中とみなす(無音の自動停止を防ぐ)
      noteInput();
      jaCount++;
      lastJaAt = Date.now();
      appendDelta("ja", ev.delta);
      break;
    case "conversation.item.input_audio_transcription.delta":
      noteInput();
      txDelta(ev.item_id, ev.delta);
      break;
    case "conversation.item.input_audio_transcription.completed":
      noteInput();
      txComplete(ev.item_id, ev.transcript);
      break;
    case "session.closed":
      stop("error", "セッションがサーバー側で終了しました");
      break;
    case "error":
      if (/commit_empty|buffer_too_small/.test(ev.error?.code || "")) {
        break; // 無音の区間を区切っただけ
      }
      if (isSpendLimit(429, ev.error)) {
        stop("error", SPEND_LIMIT_MSG);
      } else {
        // 致命的でないエラーもあるので接続は維持する(本当に切れた場合は dc/pc のイベントで停止する)
        lastError = `サーバーエラー: ${ev.error?.message || ev.error?.code || "不明"}`;
        showNotice(lastError, true);
      }
      break;
    default:
      if (isTx()) break;
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
  pane.p.textContent = fixTerms(pane.entry.text);
  dirty = true;

  // ユーザーが読み返しているとき以外は自動スクロール
  if (nearBottom) pane.el.scrollTop = pane.el.scrollHeight;
}

function markSessionStart() {
  // 2回目以降の開始では区切り線代わりに段落を切る
  for (const pane of Object.values(panes)) { pane.p = null; pane.entry = null; }
  txItems.clear();
  lastCommitAt = Date.now();
  txDeltasSinceCommit = 0;
  vadSpeechSinceCommit = false;
  vadLastLoudAt = 0;
  vadLevelSeen = false;
}

// ===== 日本語の文字起こしモード =====
function isTx(sess = session) { return sess?.mode === "transcribe"; }

function noteInput() {
  lastInputAt = Date.now();
  if (!inputSeen) { inputSeen = true; if (!lastError) showNotice(""); }
}

// 発話(item)ごとに1段落。途中経過(delta)を足していき、確定(completed)で正式な文に置き換える
function txParagraph(itemId) {
  let it = txItems.get(itemId);
  if (!it) {
    const p = document.createElement("p");
    jaText.appendChild(p);
    const entry = { lang: "ja", t: Date.now(), text: "" };
    session.entries.push(entry);
    it = { entry, p };
    txItems.set(itemId, it);
  }
  return it;
}
function txShow(it) {
  const el = jaText;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  it.p.textContent = fixTerms(it.entry.text);
  dirty = true;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}
function txDelta(itemId, delta) {
  if (!delta) return;
  const it = txParagraph(itemId || `x${Date.now()}`);
  it.entry.text += delta;
  lastTxDeltaAt = Date.now();
  txDeltasSinceCommit++;
  txShow(it);
}
function txComplete(itemId, transcript) {
  if (typeof transcript !== "string") return;
  if (!transcript.trim() && !txItems.has(itemId)) return;
  const it = txParagraph(itemId || `x${Date.now()}`);
  it.entry.text = transcript.trim();
  txShow(it);
}

// ターン検出を使わないので、区切り(commit)はアプリが送る
function vadUpdate(level) {
  if (!isTx() || state !== "live") return;
  vadLevelSeen = true;
  const threshold = Math.max(VAD_MIN_SPEECH_THRESHOLD, vadNoise * 3);
  if (level >= threshold) {
    vadLastLoudAt = Date.now();
    vadSpeechSinceCommit = true;
  } else {
    vadNoise = vadNoise * 0.9 + level * 0.1; // 静かなときの音量から雑音レベルを学習
  }
}

function txMaybeCommit(now) {
  if (!isTx() || state !== "live" || dc?.readyState !== "open") return;
  const sinceCommit = now - lastCommitAt;
  let reason = "";
  if (vadLevelSeen) {
    if (!vadSpeechSinceCommit) return; // 話し声がなければ区切らない
    const quietFor = now - vadLastLoudAt;
    if (quietFor >= VAD_PAUSE_MS) reason = "pause";
    else if (sinceCommit >= TX_COMMIT_SOFT_MAX_MS && quietFor >= 300) reason = "long";
    else if (sinceCommit >= TX_COMMIT_HARD_MAX_MS) reason = "max";
  } else if (txDeltasSinceCommit > 0 && now - lastTxDeltaAt >= TX_FALLBACK_PAUSE_MS) {
    reason = "delta-pause";
  } else if (sinceCommit >= TX_COMMIT_HARD_MAX_MS) {
    reason = "max";
  }
  if (!reason) return;
  try { dc.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch { return; }
  if (reason !== "pause") diag(`区切り(${reason}): ${Math.round(sinceCommit / 1000)}秒`);
  lastCommitAt = now;
  txDeltasSinceCommit = 0;
  vadSpeechSinceCommit = false;
}

function switchMode(mode) {
  if (state !== "idle" || (session.mode || "translate") === mode) return;
  lsSet(LS_MODE, mode);
  if (session.entries.length) {
    saveSession();
    session = createSession();
    showNotice(mode === "transcribe"
      ? "日本語の文字起こしモードにしました(新しいセッション)。前のセッションは「履歴」にあります"
      : "英→日 翻訳モードにしました(新しいセッション)。前のセッションは「履歴」にあります");
  } else {
    session.mode = mode;
    showNotice("");
  }
  renderSession();
}

function applyModeUI() {
  const tx = isTx();
  document.body.classList.toggle("mode-transcribe", tx);
  for (const b of document.querySelectorAll(".mode-switch button")) {
    b.setAttribute("aria-pressed", String((session?.mode || "translate") === b.dataset.mode));
    b.disabled = state !== "idle";
  }
  const clean = session?.showClean && session.clean ? '<span class="badge">清書版</span>' : "";
  $("jaLabel").innerHTML = (tx ? "文字起こし(日本語)" : "日本語") + clean;
  $("enLabel").innerHTML = "English" + clean;
  costEl.hidden = tx;
  $("costSep").hidden = tx;
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
    const remaining = (state === "live" ? SILENCE_TIMEOUT_MS : CONNECT_TIMEOUT_MS) - silentFor;
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
  txMaybeCommit(now);
  checkEnStall(now);
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
    if (level !== null) {
      setMeter(level);
      checkSilentMic(peer, level);
      checkQuietAudio(level);
      vadUpdate(level);
    }
    if (Date.now() - lastStatsLogAt >= STATS_LOG_MS) {
      lastStatsLogAt = Date.now();
      diag(`送信: ${bytesSent ?? "?"} bytes / ${packetsSent ?? "?"} packets / 音量 ${level === null ? "取得不可" : level.toFixed(3)}${isTx() ? "" : ` / 受信 英${enCount}・日${jaCount}`}`);
    }
  }, isTx() ? 200 : STATS_INTERVAL_MS); // 文字起こしは話し終わりの判定に使うので細かく測る
}
// 英語がまだ1つも届かず、音も小さいままなら、近づける・音量を上げるよう案内する(1回だけ)
function checkQuietAudio(level) {
  if (state !== "live" || inputSeen || !quietCheckSince) return;
  quietMaxLevel = Math.max(quietMaxLevel, level);
  if (Date.now() - quietCheckSince < QUIET_CHECK_MS) return;
  quietCheckSince = 0;
  diag(`英語未受信・最大音量 ${quietMaxLevel.toFixed(3)}`);
  if (quietMaxLevel < QUIET_LEVEL) {
    showNotice("音が小さいようです。スピーカーの音量を上げるか、iPhone をスピーカーに近づけてください(🎤 のバーが半分以上動くのが目安)");
  }
}

// ===== 集音ブースト =====
async function buildBoostedTrack(stream) {
  const level = boostSel.value;
  const gain = BOOST_GAIN[level] || 1;
  if (gain === 1) { diag("集音ブースト: オフ"); return null; }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const amp = ctx.createGain();
    amp.gain.value = gain;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const dest = ctx.createMediaStreamDestination();
    src.connect(amp).connect(comp).connect(dest);
    await ctx.resume?.().catch(() => {});
    if (ctx.state !== "running") {
      diag(`集音ブースト: AudioContext が ${ctx.state} のため使いません`);
      ctx.close().catch(() => {});
      return null;
    }
    boostCtx = ctx;
    diag(`集音ブースト: ×${gain}`);
    return dest.stream.getAudioTracks()[0];
  } catch (e) {
    diag(`集音ブースト失敗: ${e?.message || e}`);
    return null;
  }
}
// 翻訳モードで、日本語訳は届いているのに英語の文字起こしだけが止まったときの対処(1回だけ)。
// ブースト(増幅+コンプレッサー)した音だと英語側の区切り検出がうまく働かないことがあるため、生のマイクに切り替える
function checkEnStall(now) {
  if (isTx() || state !== "live" || enStallHandled || !liveSince) return;
  const jaFlowing = lastJaAt && now - lastJaAt < 5_000;
  const enSilentFor = now - (lastEnAt || liveSince);
  if (!jaFlowing || enSilentFor < EN_STALL_MS) return;
  enStallHandled = true;
  if (boostCtx && rawMicTrack?.readyState === "live" && pc) {
    diag(`英語だけ${Math.round(enSilentFor / 1000)}秒届かない(英${enCount}・日${jaCount}) → ブーストを外して生のマイクに切り替え`);
    switchToRawMic();
  } else {
    diag(`英語だけ${Math.round(enSilentFor / 1000)}秒届かない(英${enCount}・日${jaCount})。ブーストは未使用`);
    showNotice("英語の文字起こしが届いていません(日本語訳は続いています)。停止して ⚙︎ の診断ログを送ってください");
  }
}

async function switchToRawMic() {
  try {
    const sender = pc?.getSenders().find((sd) => sd.track?.kind === "audio");
    await sender?.replaceTrack(rawMicTrack);
    stopRecorder();
    startRecorder(rawMicTrack);
    closeBoost();
    showNotice("英語の文字起こしが止まったため、集音ブーストを外しました(⚙︎ で「オフ」にすると次回からこの設定になります)");
  } catch (e) {
    diag(`生のマイクへの切り替えに失敗: ${e?.message || e}`);
  }
}

function closeBoost() {
  boostCtx?.close().catch(() => {});
  boostCtx = null;
}

// ===== 用語集(表示と保存テキストの置き換え) =====
function compileGlossary() {
  glossaryRules = [];
  glossaryKeywords = [];
  for (const raw of glossaryEl.value.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s*(?:→|->|=>|＝|=)\s*(.*)$/);
    if (!m) { glossaryKeywords.push(line); continue; } // 単語だけの行はキーワード
    if (!m[1].trim()) continue;
    if (m[2].trim()) glossaryKeywords.push(m[2].trim());
    const from = m[1].trim();
    const to = m[2].trim();
    // 英数字の語は大文字小文字を区別せず、単語単位で置き換える
    const pattern = /^[\x20-\x7e]+$/.test(from)
      ? new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")
      : from;
    glossaryRules.push({ from: pattern, to });
  }
}
function fixTerms(text) {
  for (const r of glossaryRules) {
    text = typeof r.from === "string" ? text.split(r.from).join(r.to) : text.replace(r.from, r.to);
  }
  return text;
}

// ===== マイク不調の検知と復旧 =====
function watchMicTrack(track) {
  $("micName").textContent = shortMicName(track?.label);
  diag(`マイク取得: ${track?.label || "(名前なし)"} muted=${track?.muted} state=${track?.readyState} ${JSON.stringify(track?.getSettings?.() || {})}`);
  track?.addEventListener("mute", () => diag("マイクトラック mute(iOS がマイクを止めた可能性)"));
  track?.addEventListener("unmute", () => diag("マイクトラック unmute"));
  track?.addEventListener("ended", () => diag("マイクトラック ended"));
  micCheckSince = Date.now();
  micMaxLevel = 0;
}

function shortMicName(label) {
  if (!label) return "";
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

// 送っている音声がずっと完全な無音なら、マイクを取り直す(1回)。それでもだめなら画面で知らせる
function checkSilentMic(peer, level) {
  if (state !== "live" || !micCheckSince) return;
  micMaxLevel = Math.max(micMaxLevel, level);
  if (micMaxLevel >= SILENT_LEVEL) { micCheckSince = 0; return; } // 音が入っている
  if (Date.now() - micCheckSince < SILENT_MIC_MS) return;
  micCheckSince = 0;
  if (micRecoveries === 0) {
    micRecoveries++;
    diag("マイクの音量がゼロのまま → マイクを取り直します");
    recoverMic(peer);
  } else {
    const name = micStream?.getAudioTracks()[0]?.label || "不明";
    lastError = `マイクに音が入っていません(使用中: ${name})。AirPods などのイヤホンを外す、他のアプリの通話・録音を終了する、を試してから「停止」→「再開」してください`;
    showNotice(lastError, true);
    diag("再取得後も音量ゼロ");
  }
}

async function recoverMic(peer) {
  const gen = generation;
  try {
    // iPhone 本体のマイクがあれば優先する(イヤホンのマイクが選ばれて無音になる場合への対策)
    const devices = await navigator.mediaDevices.enumerateDevices();
    const builtIn = devices.find((d) => d.kind === "audioinput" && /iphone|ipad|built-?in|内蔵/i.test(d.label));
    const audio = builtIn ? { deviceId: { exact: builtIn.deviceId } } : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (gen !== generation || !pc) { stream.getTracks().forEach((t) => t.stop()); return; }
    const newTrack = stream.getAudioTracks()[0];
    const sender = peer.getSenders().find((sd) => sd.track?.kind === "audio");
    await sender?.replaceTrack(newTrack); // 復旧時はブーストを通さず生のマイクを送る
    stopRecorder();
    startRecorder(newTrack);
    micStream?.getTracks().forEach((t) => t.stop());
    closeBoost();
    micStream = stream;
    watchMicTrack(newTrack);
  } catch (e) {
    diag(`マイク再取得に失敗: ${e?.message || e}`);
  }
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
  $("glossaryBtn").disabled = state !== "idle";
  applyModeUI();
}

function setState(s) {
  state = s;
  statusEl.dataset.state = s;
  statusEl.textContent = { idle: "待機中", connecting: "接続中…", live: isTx() ? "文字起こし中" : "翻訳中" }[s];
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
  return { id, createdAt: now, updatedAt: now, durationMs: 0, entries: [], mode: lsGet(LS_MODE) === "transcribe" ? "transcribe" : "translate" };
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
  persistSession(session);
}

function persistSession(sess) {
  if (!sess || (!sess.entries.length && !sess.durationMs)) return;
  sess.updatedAt = Date.now();
  const firstEn = sess.entries.find((e) => e.lang === (isTx(sess) ? "ja" : "en"))?.text || "";
  const meta = {
    id: sess.id,
    createdAt: sess.createdAt,
    updatedAt: sess.updatedAt,
    durationMs: sess.durationMs,
    preview: firstEn.slice(0, 60),
    hasSummary: !!sess.summary,
    mode: sess.mode || "translate",
  };
  const index = loadIndex().filter((m) => m.id !== sess.id);
  index.unshift(meta);
  index.sort((a, b) => b.createdAt - a.createdAt);
  const ok = lsSet(LS_SESSION_PREFIX + sess.id, JSON.stringify(sess)) && lsSet(LS_SESSIONS, JSON.stringify(index));
  if (!ok && !storageWarned) {
    storageWarned = true;
    showNotice("端末の保存容量が足りず、字幕を保存できませんでした。履歴から古いセッションを削除してください", true);
  }
}

function renderSession() {
  enText.textContent = "";
  jaText.textContent = "";
  if (session.showClean && session.clean) {
    for (const [el, text] of [[enText, session.clean.en], [jaText, session.clean.ja]]) {
      for (const para of splitParagraphs(fixTerms(text || ""))) {
        const p = document.createElement("p");
        p.textContent = para;
        el.appendChild(p);
      }
    }
  } else {
    for (const e of session.entries) {
      const p = document.createElement("p");
      p.textContent = fixTerms(e.text);
      (e.lang === "en" ? enText : jaText).appendChild(p);
    }
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
  showNotice(`${fmtDateTime(session.createdAt)} のセッションを表示中。「再開」で続きを${isTx() ? "文字起こし" : "翻訳"}できます`);
}

function deleteSession(id) {
  if (!confirm("このセッションの字幕を削除しますか?(元に戻せません)")) return;
  try { localStorage.removeItem(LS_SESSION_PREFIX + id); } catch {}
  deleteRecordings(id);
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
    title.textContent = `${m.mode === "transcribe" ? "🎙 " : "🌐 "}${m.hasSummary ? "📝 " : ""}${fmtDateTime(m.createdAt)}(${m.durationMs < 60_000 ? "1分未満" : `${Math.round(m.durationMs / 60_000)}分`})${m.id === session.id ? " ・表示中" : ""}`;
    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = m.preview || "(英語なし)";
    info.append(title, preview);
    const btns = document.createElement("div");
    btns.className = "btns";
    btns.append(
      mkBtn("開く", () => switchSession(m.id)),
      mkBtn("保存・共有", () => {
        const s2 = m.id === session.id ? session : loadSession(m.id);
        if (s2) { $("history").close(); openShare(s2); }
      }),
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
  const join = (lang) => entries.filter((e) => e.lang === lang).map((e) => fixTerms(e.text).trim()).filter(Boolean).join("\n");
  if (isTx(sess)) {
    return [
      `ハヤメモ|日本語 文字起こし ${fmtDateTime(sess.createdAt)}(録音時間 ${fmtTime(sess.durationMs)})`,
      "",
      ...(sess.summary?.trim() ? ["【要約メモ】", sess.summary.trim(), ""] : []),
      ...(sess.clean?.ja ? ["■ 清書(録音から高精度に文字起こし)", splitParagraphs(fixTerms(sess.clean.ja)).join("\n\n"), ""] : []),
      ...(sess.speakerTranscript ? ["■ 話者別書き起こし(話者は音声から自動識別)", sess.speakerTranscript, ""] : []),
      "■ 文字起こし(リアルタイム・時刻順)",
      ...entries.map((e) => `[${time(e.t)}] ${fixTerms(e.text).trim()}`).filter((l) => !l.endsWith("] ")),
      "",
    ].join("\n");
  }
  return [
    `ハヤメモ|英→日 翻訳 ${fmtDateTime(sess.createdAt)}(翻訳時間 ${fmtTime(sess.durationMs)})`,
    "",
    ...(sess.summary?.trim() ? ["【要約メモ】", sess.summary.trim(), ""] : []),
    ...(sess.clean?.en ? [
      "■ 清書:英語(録音から高精度に文字起こし)", splitParagraphs(fixTerms(sess.clean.en)).join("\n\n"), "",
      "■ 清書:日本語訳", splitParagraphs(fixTerms(sess.clean.ja || "")).join("\n\n") || "(なし)", "",
    ] : []),
    "■ 英語原文(リアルタイム)",
    join("en") || "(なし)",
    "",
    "■ 日本語訳",
    join("ja") || "(なし)",
    "",
    ...(sess.speakerTranscript ? ["■ 話者別書き起こし(英語・話者は音声から自動識別)", sess.speakerTranscript, ""] : []),
    "■ 対訳(時刻順)",
    ...entries.map((e) => `[${time(e.t)}] ${e.lang === "en" ? "EN" : "JA"}: ${fixTerms(e.text).trim()}`),
    "",
  ].join("\n");
}

async function shareSession(sess) {
  if (!sess?.entries.length) { alert("保存する字幕がありません"); return; }
  const d = new Date(sess.createdAt);
  const pad = (n) => String(n).padStart(2, "0");
  const name = `${isTx(sess) ? "hayamemo_transcript" : "hayamemo_en-ja"}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
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

// ===== 要約メモ =====
let shareTarget = null;      // 共有画面で扱っているセッション
let summarizing = false;
let shareRecordings = [];    // 共有画面のセッションの録音

function getWorkerUrl() {
  const u = (window.APP_CONFIG?.WORKER_URL || "").replace(/\/$/, "");
  return !u || u.includes("YOUR-SUBDOMAIN") ? "" : u;
}

function openShare(sess) {
  if (!sess?.entries.length) { alert("保存する字幕がありません"); return; }
  if (sess === session) saveSession();
  shareTarget = sess;
  $("shareTitle").textContent = `${fmtDateTime(sess.createdAt)} の${isTx(sess) ? "文字起こし" : "翻訳"}セッション`;
  $("shareFullBtn").textContent = isTx(sess) ? "文字起こしの全文をファイルで保存・共有" : "英日の全文をファイルで保存・共有";
  $("summaryText").value = sess.summary || "";
  $("summaryStatus").textContent = sess.summary ? "" : "字幕の内容から、要点・決定事項・アクションを日本語でまとめます";
  shareRecordings = [];
  $("speakerOption").hidden = true;
  renderCleanUI(sess);
  renderShareButtons();
  $("shareDialog").showModal();
  getRecordings(sess.id).then((recs) => {
    if (shareTarget !== sess) return;
    shareRecordings = recs;
    const mb = recs.reduce((n, r) => n + r.blob.size, 0) / 1024 / 1024;
    const min = recs.reduce((n, r) => n + (r.endedAt - r.startedAt), 0) / 60_000;
    $("speakerOption").hidden = !recs.length;
    renderCleanUI(sess);
    $("speakerInfo").textContent = `録音 ${recs.length} 件・${min < 1 ? "1分未満" : `約${Math.round(min)}分`}(${mb.toFixed(1)}MB)${sess.speakerTranscript ? "・識別済み" : ""}`;
  });
}

function renderShareButtons() {
  const has = !!$("summaryText").value.trim();
  $("summarizeBtn").textContent = summarizing ? "作成中…" : has ? "要約を作り直す" : "📝 要約メモを作成";
  $("summarizeBtn").disabled = summarizing;
  $("shareSummaryBtn").disabled = !has || summarizing;
  $("summaryText").hidden = !has && !summarizing;
}

async function generateSummary() {
  const sess = shareTarget;
  if (!sess || summarizing) return;
  if ($("summaryText").value.trim() && !confirm("今の要約メモを作り直しますか?(編集した内容は消えます)")) return;
  const workerUrl = getWorkerUrl();
  const passphrase = passInput.value.trim();
  if (!workerUrl || !passphrase) { alert("合言葉(⚙︎ 設定)を入力してください"); return; }

  const entries = [...sess.entries].sort((a, b) => a.t - b.t);
  const join = (lang) => entries.filter((e) => e.lang === lang).map((e) => fixTerms(e.text).trim()).filter(Boolean).join("\n");
  const glossary = glossaryEl.value.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n");

  summarizing = true;
  renderShareButtons();
  try {
    let speakers = "";
    let speakerNote = "";
    if ($("useSpeakers").checked && shareRecordings.length) {
      try {
        speakers = await diarizeSession(sess, shareRecordings, workerUrl, passphrase);
      } catch (e) {
        speakerNote = `(話者の識別に失敗したため、話者なしで要約しました: ${e?.message || e})`;
      }
    }
    $("summaryStatus").textContent = "要約メモを作成しています(10〜30秒ほど)…";
    const res = await fetch(`${workerUrl}/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 清書があれば、リアルタイムより正確なそちらを使う
      body: JSON.stringify({
        passphrase, mode: sess.mode || "translate", glossary, speakers,
        en: isTx(sess) ? "" : (sess.clean?.en ? fixTerms(sess.clean.en) : join("en")),
        ja: sess.clean?.ja ? fixTerms(sess.clean.ja) : join("ja"),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.summary) {
      const msg = {
        invalid_passphrase: "合言葉が違います",
        spend_limit_exceeded: SPEND_LIMIT_MSG,
        transcript_too_long: "字幕が長すぎて要約できません(約2時間分まで)",
        empty_transcript: "要約する字幕がありません",
      }[data.error] || `要約の作成に失敗しました (${res.status} ${data.error || ""}) ${data.detail?.message || ""}`;
      throw new Error(msg);
    }
    sess.summary = data.summary;
    persistSession(sess);
    if (shareTarget === sess) {
      $("summaryText").value = data.summary;
      $("summaryStatus").textContent = speakerNote || `内容を確認・修正してから共有できます(修正は自動保存)${speakers ? "。話者は音声から自動で推定しています" : ""}`;
    }
  } catch (e) {
    $("summaryStatus").textContent = e?.message || String(e);
  } finally {
    summarizing = false;
    renderShareButtons();
  }
}

// 録音ごとに話者分け付き書き起こしを取り、時刻付きの「話者: 発言」行にする(結果はセッションに保存して再利用)
async function diarizeSession(sess, recs, workerUrl, passphrase) {
  if (sess.speakerTranscript && sess.speakerRecCount === recs.length) return sess.speakerTranscript;
  const time = (t) => new Date(t).toLocaleTimeString("ja-JP", { hour12: false });
  const lines = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const min = Math.max(1, Math.round((rec.endedAt - rec.startedAt) / 60_000));
    $("summaryStatus").textContent = `話者を識別しています(${i + 1}/${recs.length}・約${min}分の録音)…長い録音は1〜2分かかります`;
    const res = await fetch(`${workerUrl}/diarize`, {
      method: "POST",
      headers: { "Content-Type": rec.blob.type || "audio/mp4", "X-Passphrase": passphrase },
      body: rec.blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === "spend_limit_exceeded") throw new Error(SPEND_LIMIT_MSG);
      if (data.error === "audio_too_large") throw new Error("録音ファイルが大きすぎます");
      throw new Error(`${res.status} ${data.error || ""} ${data.detail?.message || ""}`.trim());
    }
    const prefix = recs.length > 1 ? `録音${i + 1}-` : "";
    let prev = null;
    for (const sg of data.segments || []) {
      const who = `${prefix}話者${sg.speaker}`;
      const text = fixTerms(sg.text);
      // 同じ話者の連続した発言は1行にまとめる
      if (prev && prev.who === who) { prev.text += ` ${text}`; continue; }
      prev = { who, t: rec.startedAt + sg.start * 1000, text };
      lines.push(prev);
    }
  }
  const transcript = lines.map((l) => `[${time(l.t)}] ${l.who}: ${l.text}`).join("\n");
  sess.speakerTranscript = transcript;
  sess.speakerRecCount = recs.length;
  persistSession(sess);
  return transcript;
}

// ===== 録音(話者分け用) =====
let recorder = null;
let recRotateTimer = null;

function startRecorder(track) {
  if (!recordEl.checked || typeof MediaRecorder === "undefined" || !track) return;
  const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
  try {
    const rec = new MediaRecorder(new MediaStream([track]), { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: REC_BITRATE });
    const chunks = [];
    const startedAt = Date.now();
    const sessionId = session.id;
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: (rec.mimeType || mime || "audio/mp4").split(";")[0] });
      if (blob.size > 2_000) saveRecording({ sessionId, startedAt, endedAt: Date.now(), blob });
    };
    rec.start(10_000);
    recorder = rec;
    clearTimeout(recRotateTimer);
    recRotateTimer = setTimeout(() => {
      if (recorder !== rec) return;
      stopRecorder();
      startRecorder(track);
    }, REC_ROTATE_MS);
    diag(`録音開始 (${rec.mimeType || mime || "既定"})`);
  } catch (e) {
    diag(`録音できません: ${e?.message || e}`);
  }
}

function stopRecorder() {
  clearTimeout(recRotateTimer);
  const rec = recorder;
  recorder = null;
  if (rec && rec.state !== "inactive") { try { rec.stop(); } catch {} }
}

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("rt-audio", 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("recordings", { keyPath: "id", autoIncrement: true });
      store.createIndex("sessionId", "sessionId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbDone(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function saveRecording(rec) {
  try {
    const db = await openAudioDb();
    await idbDone(db.transaction("recordings", "readwrite").objectStore("recordings").add(rec));
    diag(`録音を保存 ${(rec.blob.size / 1024 / 1024).toFixed(1)}MB`);
  } catch (e) {
    diag(`録音の保存に失敗: ${e?.message || e}`);
  }
}
async function getRecordings(sessionId) {
  try {
    const db = await openAudioDb();
    const recs = await idbDone(db.transaction("recordings").objectStore("recordings").index("sessionId").getAll(sessionId));
    return recs.sort((a, b) => a.startedAt - b.startedAt);
  } catch { return []; }
}
async function deleteRecordings(sessionId) {
  try {
    const db = await openAudioDb();
    const store = db.transaction("recordings", "readwrite").objectStore("recordings");
    const keys = await idbDone(store.index("sessionId").getAllKeys(sessionId));
    for (const k of keys) store.delete(k);
  } catch {}
}
async function pruneRecordings() {
  try {
    const db = await openAudioDb();
    const store = db.transaction("recordings", "readwrite").objectStore("recordings");
    const all = await idbDone(store.getAll());
    const limit = Date.now() - REC_KEEP_DAYS * 86_400_000;
    for (const r of all) if (r.startedAt < limit) store.delete(r.id);
  } catch {}
}

// ===== 清書 =====
let cleaning = false;

function renderCleanUI(sess) {
  const has = !!sess.clean;
  const recs = shareRecordings.length;
  $("cleanBtn").textContent = cleaning ? "清書中…" : has ? "清書し直す" : "✨ 清書する";
  $("cleanBtn").disabled = cleaning || !recs;
  $("cleanViewRow").hidden = !has;
  $("viewCleanBtn").classList.toggle("primary", has && !!sess.showClean);
  $("viewLiveBtn").classList.toggle("primary", has && !sess.showClean);
  if (cleaning) return;
  $("cleanInfo").textContent = !recs
    ? "録音がないため清書できません(⚙︎「音声を録音する」をオンにして翻訳・文字起こしすると使えます)"
    : has
      ? `清書済み(${fmtDateTime(sess.clean.at)})。要約メモと保存ファイルは清書版を使います`
      : isTx(sess)
        ? "録音全体を高精度のモデルで文字起こしし直し、誤変換の少ない文章にします(1分あたり約0.7円)"
        : "録音全体から英語を高精度に文字起こしし直し、日本語訳も作り直します(1分あたり約1円)";
}

function setCleanView(sess, on) {
  if (!sess?.clean) return;
  sess.showClean = on;
  persistSession(sess);
  if (sess === session) renderSession();
  renderCleanUI(sess);
}

async function cleanSession(sess) {
  if (!sess || cleaning || !shareRecordings.length) return;
  if (sess.clean && !confirm("清書をやり直しますか?(料金がもう一度かかります)")) return;
  const workerUrl = getWorkerUrl();
  const passphrase = passInput.value.trim();
  if (!workerUrl || !passphrase) { alert("合言葉(⚙︎ 設定)を入力してください"); return; }
  const recs = shareRecordings;
  const lang = isTx(sess) ? "ja" : "en";
  cleaning = true;
  renderCleanUI(sess);
  try {
    const parts = [];
    for (let i = 0; i < recs.length; i++) {
      const min = Math.max(1, Math.round((recs[i].endedAt - recs[i].startedAt) / 60_000));
      $("cleanInfo").textContent = `清書しています(${i + 1}/${recs.length}・約${min}分の録音)…長い録音は1〜2分かかります`;
      const res = await fetch(`${workerUrl}/clean`, {
        method: "POST",
        headers: {
          "Content-Type": recs[i].blob.type || "audio/mp4",
          "X-Passphrase": passphrase,
          "X-Lang": lang,
          "X-Keywords": encodeURIComponent(JSON.stringify(glossaryKeywords)),
        },
        body: recs[i].blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(res.status, data, "清書"));
      diag(`清書 ${i + 1}/${recs.length}: ${data.model}${data.fallback ? "(簡易設定)" : ""} ${String(data.text || "").length}文字`);
      if (data.text) parts.push(data.text);
    }
    const source = parts.join("\n\n");
    if (!source.trim()) throw new Error("録音から文字を起こせませんでした(無音だった可能性があります)");
    const clean = { at: Date.now() };
    if (lang === "ja") {
      clean.ja = source;
    } else {
      clean.en = source;
      $("cleanInfo").textContent = "清書した英語を日本語に翻訳しています…";
      const res = await fetch(`${workerUrl}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase, en: fixTerms(source), glossary: glossaryRulesText() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(res.status, data, "翻訳"));
      clean.ja = data.ja;
    }
    sess.clean = clean;
    sess.showClean = true;
    persistSession(sess);
    if (sess === session) renderSession();
  } catch (e) {
    cleaning = false;
    renderCleanUI(sess);
    $("cleanInfo").textContent = e?.message || String(e);
    return;
  }
  cleaning = false;
  renderCleanUI(sess);
}

function apiErrorMessage(status, data, what) {
  return {
    invalid_passphrase: "合言葉が違います",
    spend_limit_exceeded: SPEND_LIMIT_MSG,
    audio_too_large: "録音ファイルが大きすぎます",
    transcript_too_long: "長すぎて処理できません",
  }[data.error] || `${what}に失敗しました (${status} ${data.error || ""}) ${data.detail?.message || ""}`.trim();
}

// 清書の文章は改行が少ないので、文の区切りで読みやすい段落に分ける
function splitParagraphs(text) {
  const out = [];
  for (const block of String(text).split(/\n\s*\n|\n/)) {
    const sentences = block.match(/[^。！？!?]+[。！？!?]?|[^.]+\.(\s|$)/g) || (block.trim() ? [block] : []);
    let cur = "";
    for (const sn of sentences) {
      cur += sn;
      if (cur.length >= 120) { out.push(cur.trim()); cur = ""; }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

// ===== 用語集(独立した画面) =====
function glossaryRulesText() {
  return glossaryEl.value.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n");
}

function openGlossary() {
  if (state !== "idle") return;
  buildGlossaryUI();
  $("glossaryDialog").showModal();
}

// テキスト(保存形式)から一覧を作る
function buildGlossaryUI() {
  const rules = [], keywords = [];
  for (const raw of glossaryEl.value.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s*(?:→|->|=>|＝|=)\s*(.*)$/);
    if (m) rules.push([m[1].trim(), m[2].trim()]);
    else keywords.push(line);
  }
  $("ruleList").textContent = "";
  $("keywordList").textContent = "";
  for (const [from, to] of rules) addTermRow("rule", from, to, false);
  for (const k of keywords) addTermRow("keyword", k, "", false);
  showEmptyHints();
}

function addTermRow(kind, a = "", b = "", focus = true) {
  const list = $(kind === "rule" ? "ruleList" : "keywordList");
  const row = document.createElement("div");
  row.className = "term-row";
  const mk = (val, ph) => {
    const i = document.createElement("input");
    i.value = val;
    i.placeholder = ph;
    i.autocapitalize = "off";
    i.spellcheck = false;
    i.addEventListener("input", saveGlossaryFromUI);
    return i;
  };
  if (kind === "rule") {
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    row.append(mk(a, "誤り(例: グリフォサート)"), arrow, mk(b, "正しい(例: グリホサート)"));
  } else {
    row.append(mk(a, "例: ドローン散布"));
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "small-btn danger del";
  del.textContent = "×";
  del.setAttribute("aria-label", "削除");
  del.addEventListener("click", () => { row.remove(); saveGlossaryFromUI(); showEmptyHints(); });
  row.appendChild(del);
  list.querySelector(".term-empty")?.remove();
  list.appendChild(row);
  if (focus) row.querySelector("input").focus();
}

function showEmptyHints() {
  for (const [id, text] of [["ruleList", "まだありません"], ["keywordList", "まだありません"]]) {
    const list = $(id);
    if (!list.querySelector(".term-row") && !list.querySelector(".term-empty")) {
      const p = document.createElement("p");
      p.className = "term-empty";
      p.textContent = text;
      list.appendChild(p);
    }
  }
}

// 一覧の内容を保存形式のテキストに戻して保存する
function saveGlossaryFromUI() {
  const lines = [];
  for (const row of $("ruleList").querySelectorAll(".term-row")) {
    const [from, to] = [...row.querySelectorAll("input")].map((i) => i.value.trim());
    if (from && to) lines.push(`${from} → ${to}`);
  }
  for (const row of $("keywordList").querySelectorAll(".term-row")) {
    const k = row.querySelector("input").value.trim();
    if (k) lines.push(k);
  }
  glossaryEl.value = lines.join("\n") + (lines.length ? "\n" : "");
  lsSet(LS_GLOSSARY, glossaryEl.value);
  compileGlossary();
  if (state === "idle" && session) renderSession();
}

async function shareSummary() {
  const text = $("summaryText").value.trim();
  if (!text || !shareTarget) return;
  const title = `ハヤメモ 要約メモ ${fmtDateTime(shareTarget.createdAt)}`;
  const body = `${title}\n\n${text}\n`;
  // LINE・メール・メモなどにそのまま貼れるよう、テキストとして共有する
  if (navigator.share) {
    try { await navigator.share({ title, text: body }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(body); alert("要約メモをコピーしました"); }
  catch { prompt("コピーしてください", body); }
}

function fmtDateTime(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 180000 → "3分"、45000 → "45秒"
function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  return sec % 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec / 60}分`;
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
