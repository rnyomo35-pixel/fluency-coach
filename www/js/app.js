/* ════════════════════════════════════════════════════════════════
   English Fluency Coach — app logic
   Flow: blind topic draw → open-ended speech capture (the learner stops
        it) → Gemini evaluation (structured JSON) → scorecard
   ════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ────────────── Constants & state ────────────── */
  const KEY_STORAGE = "gemini_api_key";          // localStorage key
  const SOFT_TARGET_SEC = 20;                    // ring fills here; the clock keeps counting
  /* Current GA model first; Google retires ids over time, so a retired one
     (404 / "no longer available") falls through to the backup instead of
     failing the learner's attempt. */
  const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
  const geminiUrl = (model) =>
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  /* The evaluation streams its answer: the first tokens arrive in seconds, so
     the app can tell "still working" from "stuck" instead of throwing away a
     slow-but-healthy reply with one fixed wall-clock cap. */
  const IDLE_TIMEOUT_MS = 30_000;   // no data for this long = the stream is dead
  const TOTAL_TIMEOUT_MS = 120_000; // absolute ceiling for a single request
  const HISTORY_KEY = "session_history";    // localStorage key
  const VOCAB_KEY = "vocabulary";           // saved words & phrases
  const VOCAB_MAX = 200;
  const HISTORY_MAX = 100;                  // stored attempts cap
  const TREND_MAX = 20;                     // points shown in the trend chart

  const state = {
    topic: "",
    recording: false,
    evaluating: false,
    lastResult: null,
    session: null, // live “pointer” to the active recording session object
    ring: null, // active rAF handle
  };

  /* ────────────── Element handles ────────────── */
  const $ = (id) => document.getElementById(id);
  const els = {
    btnNewTopic2: $("btn-new-topic-2"),
    topicText: $("topic-text"),
    btnStart: $("btn-start-speaking"),
    btnRetry: $("btn-retry-topic"),
    timerSection: $("timer-section"),
    ringProgress: $("ring-progress"),
    timerSeconds: $("timer-seconds"),
    timerWrap: document.querySelector(".timer-wrap"),
    liveTranscript: $("live-transcript"),
    screenFlow: $("screen-flow"),
    screenScore: $("screen-scorecard"),
    scoreValue: $("score-value"),
    scoreTitle: $("score-title"),
    scoreArc: $("score-arc"),
    heardText: $("heard-text"),
    mistakesList: $("mistakes-list"),
    mistakesSection: $("mistakes-section"),
    c1Text: $("c1-text"),
    feedbackText: $("feedback-text"),
    btnSettings: $("btn-settings"),
    settingsModal: $("settings-modal"),
    btnCloseSettings: $("btn-close-settings"),
    apiKeyInput: $("api-key-input"),
    btnPeekKey: $("btn-peek-key"),
    btnClearKey: $("btn-clear-key"),
    btnSaveKey: $("btn-save-key"),
    keyStatus: $("key-status"),
    flowNote: $("flow-note"),
    /* streak */
    streakChip: $("streak-chip"),
    /* history */
    btnHistory: $("btn-history"),
    screenHistory: $("screen-history"),
    btnBackMain: $("btn-back-main"),
    btnClearHistory: $("btn-clear-history"),
    historyEmpty: $("history-empty"),
    historyStats: $("history-stats"),
    sTotal: $("s-total"),
    sBest: $("s-best"),
    sAvg: $("s-avg"),
    chartSection: $("chart-section"),
    trendLine: $("trend-line"),
    trendPoints: $("trend-points"),
    trendAvg: $("trend-avg"),
    historyList: $("history-list"),
    /* vocabulary */
    btnVocab: $("btn-vocab"),
    screenVocab: $("screen-vocab"),
    btnVocabBack: $("btn-vocab-back"),
    btnScoreBack: $("btn-score-back"),
    saveC1Hint: $("save-c1-hint"),
    flashDeck: $("flash-deck"),
    flashStage: $("flash-stage"),
    flashEmpty: $("flash-empty"),
    flashHint: $("flash-hint"),
    btnFlashGot: $("btn-flash-got"),
    btnFlashAgain: $("btn-flash-again"),
    btnFlashRestart: $("btn-flash-restart"),
    flashProgress: $("flash-progress"),
    /* design chrome */
    btnNavPractice: $("btn-nav-practice"),
    btnSpeakingBack: $("btn-speaking-back"),
    sessionNumber: $("session-number"),
    feedbackSession: $("feedback-session"),
    scoreSubtitle: $("score-subtitle"),
    chartAvg: $("chart-avg"),
    topicIndex: $("topic-index"),
  };

  /* Bottom navigation: exactly one destination is lit at a time. */
  const NAV_ITEMS = {
    practice: $("btn-nav-practice"),
    vocabulary: $("btn-vocab"),
    history: $("btn-history"),
  };

  function setNav(name) {
    Object.keys(NAV_ITEMS).forEach((key) => {
      const btn = NAV_ITEMS[key];
      if (!btn) return;
      const on = key === name;
      btn.classList.toggle("selected", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
  }

  /* The dial lives in a 198-unit viewBox now, so the ring length is read from
     the circle itself instead of a hard-coded radius. */
  const RING_CIRCUMFERENCE = 2 * Math.PI * Number(els.ringProgress.getAttribute("r") || 88);
  els.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);

  /* Native detection: inside Capacitor iOS the native runtime injects the
     window.Capacitor bridge, exposing installed plugins on Capacitor.Plugins. */
  const cap = window.Capacitor || null;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const nativeSpeech =
    isNative && cap.Plugins && cap.Plugins.SpeechRecognition ? cap.Plugins.SpeechRecognition : null;

  /* ────────────── Tiny helpers ────────────── */
  /* Messages live in the layout, never in a floating box: one quiet line in
     the dock that fades out of the text itself. Nothing covers the screen. */
  let noteTimer = null;
  function note(msg, isErr = false, ms = 6000) {
    if (!els.flowNote) return;
    els.flowNote.textContent = msg;
    els.flowNote.classList.toggle("err", isErr);
    clearTimeout(noteTimer);
    if (ms > 0) noteTimer = setTimeout(() => { els.flowNote.textContent = ""; }, ms);
  }

  function getApiKey() {
    return (localStorage.getItem(KEY_STORAGE) || "")
      .trim()
      .replace(/^[\s"'`]+|[\s"'`]+$/g, ""); // tolerate a key pasted with quotes
  }

  /* The icons are the exported Figma assets, so the button matches the design
     exactly (both are drawn in ink for the brass surface). */
  const MIC_ICON = '<img src="assets/de5bc.svg" width="20" height="20" alt="" aria-hidden="true" />';
  const STOP_ICON = '<img src="assets/b53a6.svg" width="20" height="20" alt="" aria-hidden="true" />';
  const evaluatingLabel = '<span class="btn-spinner"></span><span>Evaluating with Gemini…</span>';
  let evalTicker = null;

  /* A visible clock on the wait: the learner can see the request is alive
     instead of staring at a frozen label. The spinner is rendered ONCE and only
     its sibling text is rewritten — rebuilding the button each tick restarted
     the CSS animation, which is what made it stutter. */
  function startEvalTicker() {
    const started = performance.now();
    clearInterval(evalTicker);
    setStartButton('<span class="btn-spinner"></span><span>Evaluating… 0s</span>', true);
    const count = els.btnStart.querySelector("span:last-child");
    const paint = () => {
      if (!count) return;
      count.textContent = "Evaluating… " + Math.round((performance.now() - started) / 1000) + "s";
    };
    paint();
    evalTicker = setInterval(paint, 1000);
  }

  function stopEvalTicker() {
    clearInterval(evalTicker);
    evalTicker = null;
  }
  const stopLabel = STOP_ICON + '<span>Stop &amp; Evaluate</span>';

  function setStartButton(label, disabled) {
    els.btnStart.innerHTML = label;
    els.btnStart.disabled = disabled;
  }

  function buildStartLabel() {
    return MIC_ICON + '<span>Start Speaking (Blind Draw)</span>';
  }

  function resetStartButton() {
    els.btnStart.classList.remove("recording");
    setStartButton(buildStartLabel(), false);
  }

  /* ────────────── Settings modal (API key) ────────────── */
  let keyLoadedForEdit = "";

  function openSettings() {
    const saved = getApiKey();
    keyLoadedForEdit = saved;
    els.keyStatus.textContent = saved ? "✓ A key is saved on this device" : "No key saved yet";
    els.keyStatus.className = "key-status " + (saved ? "ok" : "");
    els.apiKeyInput.value = "";
    els.apiKeyInput.placeholder = saved ? "● ● ● ● ● ● ● ● (key hidden)" : "Paste your API key";
    els.settingsModal.classList.add("is-open");
    els.settingsModal.setAttribute("aria-hidden", "false");
  }

  function closeSettings() {
    els.settingsModal.classList.remove("is-open");
    els.settingsModal.setAttribute("aria-hidden", "true");
  }

  /* Tapping the scrim dismisses — the same path the sheet leaves by. */
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });

  /* Drag-to-dismiss on the sheet: 1:1 tracking from where the finger grabbed,
     rubber-band when dragged past the top, and Apple's momentum projection at
     release so a quick flick dismisses even over a short distance. */
  (function wireSheetDrag() {
    const sheet = els.settingsModal.querySelector(".modal");
    if (!sheet) return;
    let dragging = false;
    let startY = 0;
    let dy = 0;
    const samples = []; // rolling {y,t} window — a single 1ms delta must not read as a flick

    function pushSample(y) {
      const now = performance.now();
      samples.push({ y: y, t: now });
      while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
    }

    function releaseVelocity() {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt < 16) return 0; // shorter than a frame is not a gesture
      const v = (last.y - first.y) / dt;
      return Math.max(-4, Math.min(4, v)); // px/ms, clamped
    }

    sheet.addEventListener("pointerdown", (e) => {
      if (e.target.closest("input, button, a, summary")) return; // never hijack controls
      dragging = true;
      startY = e.clientY;
      dy = 0;
      samples.length = 0;
      pushSample(e.clientY);
      sheet.style.transition = "none";
      try { sheet.setPointerCapture(e.pointerId); } catch (_) {}
    });

    sheet.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      pushSample(e.clientY);
      const offset = e.clientY - startY;
      dy = Math.max(offset, 0);
      // Upward drags resist instead of hitting a wall.
      const shown = offset >= 0 ? offset : offset * 0.28;
      sheet.style.transform = "translateY(" + shown + "px)";
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try {
        if (e && e.pointerId != null && sheet.hasPointerCapture(e.pointerId)) {
          sheet.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
      /* Apple's projection: v/1000 · d/(1-d) with d = 0.998, velocity in px/ms
         → projected px ≈ velocity * 499 beyond the current position. */
      const projected = dy + releaseVelocity() * 499;
      const dismiss = dy > 72 || projected > 170;
      dy = 0;
      sheet.style.transition = "";
      if (dismiss) closeSettings();
      sheet.style.transform = ""; // settle back on the sheet curve
    }

    sheet.addEventListener("pointerup", endDrag);
    sheet.addEventListener("pointercancel", endDrag);
  })();

  els.btnSaveKey.addEventListener("click", () => {
    const value = els.apiKeyInput.value.trim() || keyLoadedForEdit; // keep saved key if field untouched
    if (!value) {
      els.keyStatus.textContent = "Please paste a Gemini API key first.";
      els.keyStatus.className = "key-status err";
      return;
    }
    /* Keys come in several shapes (the classic "AIza…" form is only one of
       them), so the client only checks that the value is plausible — Google
       decides whether it actually works. */
    const cleaned = value.replace(/^[\s"'`]+|[\s"'`]+$/g, "");
    if (cleaned.length < 15 || /\s/.test(cleaned)) {
      els.keyStatus.textContent = "That key looks incomplete — paste the whole value.";
      els.keyStatus.className = "key-status err";
      return;
    }
    localStorage.setItem(KEY_STORAGE, cleaned);
    els.keyStatus.textContent = "✓ Key saved — you're ready to coach!";
    els.keyStatus.className = "key-status ok";
    keyLoadedForEdit = cleaned;
    els.apiKeyInput.value = "";
    els.apiKeyInput.placeholder = "● ● ● ● ● ● ● ● (key hidden)";
    setTimeout(closeSettings, 900);
  });

  els.btnClearKey.addEventListener("click", () => {
    localStorage.removeItem(KEY_STORAGE);
    keyLoadedForEdit = "";
    els.apiKeyInput.value = "";
    els.apiKeyInput.placeholder = "Paste your API key";
    els.keyStatus.textContent = "Key removed.";
    els.keyStatus.className = "key-status";
  });

  els.btnPeekKey.addEventListener("click", () => {
    if (els.apiKeyInput.type === "password") {
      els.apiKeyInput.value = els.apiKeyInput.value.trim() || getApiKey();
      els.apiKeyInput.type = "text";
    } else {
      els.apiKeyInput.value = "";
      els.apiKeyInput.type = "password";
    }
  });

  els.btnSettings.addEventListener("click", openSettings);
  els.btnCloseSettings.addEventListener("click", closeSettings);
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });

  /* ────────────── Topics ────────────── */
  /* There is no read-ahead screen any more: a topic exists only as part of a
     live attempt, drawn at the same instant the clock and the mic start. */
  els.btnNewTopic2.addEventListener("click", () => startSpeakingFlow());

  function revealTopic(topic) {
    els.topicText.textContent = topic;
    els.topicText.classList.remove("placeholder");
    const drawNumber = loadHistory().length + 1;
    if (els.topicIndex) els.topicIndex.textContent = "TOPIC " + String(drawNumber).padStart(3, "0");
    if (els.sessionNumber) els.sessionNumber.textContent = pad2(drawNumber);
    // fresh animation for every draw
    els.topicText.style.animation = "none";
    void els.topicText.offsetWidth;
    els.topicText.style.animation = "topicIn .45s cubic-bezier(.2,.9,.3,1.2)";
  }

  function hideAllScreens() {
    els.screenFlow.classList.add("hidden");
    els.screenScore.classList.add("hidden");
    els.screenHistory.classList.add("hidden");
    els.screenVocab.classList.add("hidden");
  }

  function showFlowScreen() {
    hideAllScreens();
    els.screenFlow.classList.remove("hidden");
    setNav("practice");
  }

  function showScoreScreen() {
    hideAllScreens();
    els.screenScore.classList.remove("hidden");
    setNav("practice");
  }

  /* The way back from a scorecard: same screen the app opens on, topic cleared
     so the next start is a fresh blind draw. */
  const TOPIC_PLACEHOLDER = "Tap start — the topic appears the instant the clock starts.";
  function goHome() {
    if (state.recording || state.evaluating) return;
    state.topic = "";
    els.topicText.textContent = TOPIC_PLACEHOLDER;
    els.topicText.classList.add("placeholder");
    els.timerSection.classList.add("hidden");
    resetTimerUI();
    resetStartButton();
    els.screenFlow.classList.remove("is-speaking");
    showFlowScreen();
  }

  const style = document.createElement("style");
  style.textContent =
    "@keyframes topicIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }";
  document.head.appendChild(style);

  /* ────────────── The stopwatch: counts up, never cuts you off ────────────── */
  let stopwatchStop = null;

  function startStopwatch() {
    const started = performance.now();
    let lastSec = -1;
    let stopped = false;

    /* The ring fills over the soft target in one CSS transition (no per-frame
       stroke writes), then stays full: past 20 s the attempt is simply good. */
    els.ringProgress.style.transition = "none";
    els.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    void els.ringProgress.getBoundingClientRect();
    els.ringProgress.style.transition =
      "stroke-dashoffset " + SOFT_TARGET_SEC * 1000 + "ms linear";
    els.ringProgress.style.strokeDashoffset = "0";

    function frame(now) {
      if (stopped) return;
      const sec = Math.floor((now - started) / 1000);
      if (sec !== lastSec) {           // one write per second, not per frame
        els.timerSeconds.textContent = formatClock(sec);
        lastSec = sec;
      }
      if (sec >= SOFT_TARGET_SEC && !els.timerWrap.classList.contains("good")) {
        els.timerWrap.classList.add("good");
        const targetLabel = els.timerWrap.querySelector(".timer-label");
        if (targetLabel) targetLabel.textContent = SOFT_TARGET_SEC + "s TARGET REACHED";
      }
      state.ring = requestAnimationFrame(frame);
    }

    state.ring = requestAnimationFrame(frame);
    stopwatchStop = () => {
      stopped = true;
      if (state.ring) cancelAnimationFrame(state.ring);
      state.ring = null;
      els.ringProgress.style.transition = "none";
      return performance.now() - started;
    };
  }

  function stopStopwatch() {
    const ms = stopwatchStop ? stopwatchStop() : 0;
    stopwatchStop = null;
    return ms;
  }

  /* The live dial reads 00:27, as in the design. */
  function formatClock(sec) {
    return pad2(Math.floor(sec / 60)) + ":" + pad2(sec % 60);
  }

  function resetTimerUI() {
    stopStopwatch();
    els.ringProgress.style.transition = "none";
    els.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    els.timerSeconds.textContent = "00:00";
    els.timerSeconds.classList.remove("warn");
    els.timerWrap.classList.remove("final", "good");
    const idleLabel = els.timerWrap.querySelector(".timer-label");
    if (idleLabel) idleLabel.textContent = "KEEP GOING";
    els.liveTranscript.textContent = "Listening…";
    els.liveTranscript.classList.remove("active");
  }

  /* ────────────── Speech capture (native iOS ⇄ web) ────────────── */

  /* beginSpeechCapture resolves after listening has started and returns
     a stop() function to end the capture immediately. */
  async function beginSpeechCapture(onPartial, onError, onReady) {
    return nativeSpeech
      ? captureNativeSpeech(onPartial, onError, onReady)
      : captureWebSpeech(onPartial, onError, onReady);
  }

  /* @capacitor-community/speech-recognition 6.x reports ONE permission field,
     `speechRecognition` (the mic prompt is raised by start() itself). The old
     gate also required `microphone`, which the plugin never returns — so it
     always read "denied" and capture never began. */
  async function ensureSpeechPermission(SR) {
    const granted = async () => {
      try {
        const p = await SR.checkPermissions();
        return !!p && p.speechRecognition === "granted";
      } catch (_) {
        return false;
      }
    };
    if (await granted()) return true;
    try { await SR.requestPermissions(); } catch (_) {}
    return granted();
  }

  async function captureNativeSpeech(onPartial, onError, onReady) {
    const SR = nativeSpeech;
    const startOpts = () => ({
      language: "en-US",
      maxResults: 1,
      prompt: "Speak freely — tap Stop when your thought is finished.",
      partialResults: true,
      popup: false,            // never a native dialog on top of the app
    });

    let starting = false;
    let restarts = 0;
    let stoppedByUs = false;

    const begin = async () => {
      if (starting) return;
      starting = true;
      try {
        await SR.start(startOpts());
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // "ongoing" only means a task is already listening — not a failure.
        if (!/ongoing/i.test(msg)) onError("Speech recognition could not start: " + msg);
      } finally {
        starting = false;
      }
    };

    try {
      if (!(await ensureSpeechPermission(SR))) {
        onError(
          "Speech access is off. Turn on Speech Recognition and Microphone for Fluency Coach in iOS Settings → Privacy & Security."
        );
        return () => {};
      }

      const availability = await SR.available();
      if (!availability || !availability.available) {
        onError("Speech recognition is unavailable on this device (check that Siri & Dictation are enabled and you're online).");
        return () => {};
      }

      SR.addListener("partialResults", (data) => {
        const matches = (data && data.matches) || [];
        const text = matches.join(" ").trim();
        if (text) onPartial(text);
      });

      /* iOS ends a recognition task when the request dies or the audio pauses;
         resume it while the attempt still has time so a pause never costs the
         window (guarded, so a broken engine cannot loop). */
      SR.addListener("listeningState", (data) => {
        if (!data) return;
        if (data.status === "started") {
          // Proof that the engine runs: release the start lock even if the
          // start() promise is still pending (iOS may never settle it).
          starting = false;
          return;
        }
        if (stoppedByUs || data.status !== "stopped") return;
        if (restarts >= 3) return;
        restarts += 1;
        begin();
      });

      // Permission is settled and a listener is in place: the clock may start
      // now, even while the native engine is still warming up.
      onReady();
      begin();
      return () => { stoppedByUs = true; };
    } catch (err) {
      onError("Speech recognition failed to start: " + (err && err.message ? err.message : String(err)));
      return () => {};
    }
  }

  async function captureWebSpeech(onPartial, onError, onReady) {
    const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SRClass) {
      onError("This browser has no speech recognition. Use Safari/Chrome, or run the app natively via Capacitor.");
      return () => {};
    }
    const rec = new SRClass();
    window.__webkitRecognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    // detached: true once the session's cutoff stop() runs — all events after
    // that are stragglers and must not touch the next session's state.
    let detached = false;
    let fatal = false;

    const FATAL_WEB_ERRORS = {
      "not-allowed": "Microphone access denied — allow it for this site/app in iOS Settings or the browser prompt.",
      "service-not-allowed": "Speech recognition is blocked on this device (browser policy).",
      "audio-capture": "No microphone found on this device.",
      "hardware": "Microphone hardware problem detected.",
    };

    let finalText = "";

    rec.onresult = (event) => {
      // NOTE: results are gated only on the session pointer (checked inside
      // onPartial), so a final utterance flushed after the cutoff can still
      // land in the live session during DRAIN_MS. `detached` is used purely
      // to stop restarts and engine work.
      if (fatal) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += " " + res[0].transcript;
        else interim += " " + res[0].transcript;
      }
      onPartial((finalText + " " + interim).trim());
    };

    rec.onerror = (e) => {
      if (detached || fatal) return;
      const kind = e && e.error;
      if (kind === "aborted" || kind === "no-speech") return; // normal silence in the window
      const fatalMsg = FATAL_WEB_ERRORS[kind];
      if (fatalMsg) {
        // Dead mic/service: stop restarting, report once.
        fatal = true;
        onError(fatalMsg);
        try { rec.stop(); } catch (_) {}
        return;
      }
      if (kind === "network") {
        note("Speech service unreachable (network) — this attempt may be incomplete", true, 3200);
        return;
      }
      note("Speech warning: " + kind, true, 2400);
    };

    rec.onend = () => {
      // Early end (silence/browser policy): restart ONLY while the session is
      // live and the failure was not fatal. After the 10s cutoff, detached is
      // true and this becomes a no-op.
      if (!detached && !fatal && state.recording) {
        try { rec.start(); } catch (_) {}
      }
    };

    if (onReady) onReady(); // the clock never waits for the engine
    try { rec.start(); } catch (err) {
      onError("Speech recognition failed to start: " + String(err));
      return () => {};
    }
    return () => {
      detached = true;
      try { rec.stop(); } catch (_) {}
    };
  }

  /* ────────────── Start speaking flow ──────────────
     Every session gets its own identity object. All speech events, the timer
     cutoff and the evaluation carry this object through, so events from a
     finished/aborted capture can never write into the *next* session.
     state.session is the "live pointer": null once a session is torn down. */

  const DRAIN_MS = 450; // grace window for late final transcripts after stop()
  const drain = (ms) => new Promise((r) => setTimeout(r, ms));

  els.btnStart.addEventListener("click", () => {
    /* One button, two jobs: start the blind attempt, or end it when the
       learner has finished the thought. */
    if (state.recording && state.session && state.session.requestStop) {
      setStartButton(evaluatingLabel, true);
      state.session.requestStop();
      return;
    }
    startSpeakingFlow();
  });

  async function startSpeakingFlow(sameTopic) {
    if (state.recording || state.evaluating) return;

    if (!getApiKey()) {
      note("Save your Gemini API key first ⚙️", true, 6000);
      openSettings();
      return;
    }

    /* Blind draw: the topic is chosen, revealed and timed in the SAME task as
       the tap — there is no window in which an answer could be planned. */
    const topic = sameTopic || getRandomTopic(state.topic);
    state.topic = topic;
    showFlowScreen();
    resetTimerUI();
    revealTopic(topic);
    els.timerSection.classList.remove("hidden");
    els.liveTranscript.classList.add("active");
    els.liveTranscript.textContent = "Listening…";
    els.btnStart.classList.add("recording");
    els.screenFlow.classList.add("is-speaking");
    setStartButton(stopLabel, false);

    const session = { topic: topic, transcript: "", error: null, elapsedSec: 0 };
    state.recording = true;
    state.session = session;

    let resolveStop = null;
    const stopRequested = new Promise((resolve) => { resolveStop = resolve; });
    session.requestStop = (err) => {
      if (err && !session.error) session.error = err;
      resolveStop();
    };

    startStopwatch(); // clock and microphone start in the same tick as the tap

    // Speech events are gated on session identity + liveness:
    /* Speech partials can arrive faster than the display can use them; collapse
       a burst into at most one DOM write per frame. */
    let pendingTranscript = null;
    let transcriptFrame = 0;
    const flushTranscript = () => {
      transcriptFrame = 0;
      if (pendingTranscript === null) return;
      const next = "🎙 " + (pendingTranscript || "Listening…");
      if (els.liveTranscript.textContent !== next) els.liveTranscript.textContent = next;
      pendingTranscript = null;
    };
    const onPartial = (text) => {
      if (state.session !== session) return; // straggler from a dead session
      session.transcript = text;
      pendingTranscript = text;
      if (!transcriptFrame) transcriptFrame = requestAnimationFrame(flushTranscript);
    };
    let stopCapture = () => {};
    try {
      stopCapture = await beginSpeechCapture(onPartial, session.requestStop, () => {});
    } catch (err) {
      session.requestStop(
        "Speech capture crashed: " + (err && err.message ? err.message : String(err))
      );
    }

    // The attempt ends when the learner taps Stop — or when the engine dies.
    await stopRequested;
    if (state.session !== session) { // aborted meanwhile
      try { stopCapture(); } catch (_) {}
      return;
    }
    session.elapsedSec = Math.max(1, Math.round(stopStopwatch() / 1000));

    // ── Stop: end the mic, then DRAIN. iOS/Safari can flush the final
    // utterance shortly after stop(); the session stays live (and therefore
    // mutable) during that window so the trailing words are not lost — then
    // we tear it down, so stragglers can never leak into the next attempt.
    try { stopCapture(); } catch (_) {}
    await killCaptureRunnable();
    await drain(DRAIN_MS);
    if (state.session !== session) return;

    await teardownSession(session);
    finishSpeaking(session);
  }

  /* Stops the engine but deliberately KEEPS listeners for the drain window —
     late final results must still be able to reach the live session. */
  async function killCaptureRunnable() {
    if (nativeSpeech) {
      try { await nativeSpeech.stop(); } catch (_) {}
    } else if (window.__webkitRecognition) {
      try { window.__webkitRecognition.stop(); } catch (_) {}
    }
  }

  async function teardownSession(session) {
    // Drain is over: now it is safe to detach stream listeners.
    if (nativeSpeech) {
      try { nativeSpeech.removeAllListeners && nativeSpeech.removeAllListeners(); } catch (_) {}
    }
    resetTimerUI();
    els.timerSection.classList.add("hidden");
    els.screenFlow.classList.remove("is-speaking");
    state.recording = false;
    if (state.session === session) state.session = null; // its events are dead from here on
  }

  async function finishSpeaking(session) {
    resetStartButton();

    if (session.error) {
      note(session.error, true, 5000);
      return;
    }

    const final = (session.transcript || "").trim();

    if (!final || final.replace(/[^a-z0-9']/gi, "").length < 4) {
      note("No speech detected — tap start and speak right away! 🎤", true, 4500);
      els.liveTranscript.textContent = "";
      return;
    }

    state.evaluating = true;
    startEvalTicker();
    await evaluateWithGemini(final, session);
  }

  /* ────────────── Gemini evaluation ────────────── */
  const GEMINI_SCHEMA = {
    type: "OBJECT",
    properties: {
      score: { type: "INTEGER" },
      mistakes: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            error: { type: "STRING" },
            type: { type: "STRING" },
            correction: { type: "STRING" },
            explanation: { type: "STRING" },
          },
          required: ["error", "correction", "explanation"],
        },
      },
      c1_rephrase: { type: "STRING" },
      feedback: { type: "STRING" },
      vocab: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            said: { type: "STRING" },
            better: { type: "STRING" },
            why: { type: "STRING" },
          },
          required: ["said", "better", "why"],
        },
      },
    },
    required: ["score", "mistakes", "c1_rephrase", "feedback", "vocab"],
  };

  function buildPrompt(topic, transcript, seconds) {
    const dur = seconds;
    return [
      "You are an expert English fluency coach helping a learner build C1-level spontaneous speaking.",
      "The learner drew this topic blind (no preparation time: the topic appeared at the same instant the clock started) and spoke off the top of their head for about " + dur + " seconds, stopping when the thought was finished.",
      "",
      'TOPIC: "' + topic + '"',
      'WHAT THE LEARNER SAID (speech-to-text of the ' + dur + '-second attempt): "' + transcript + '"',
      "",
      "Evaluate this spontaneous speaking burst. Judge fluency, word choice, grammar accuracy and how well they developed the thought in the time they used — judge quality, not length: a tight 20-second answer can be excellent, and rambling is not a virtue.",
      "Score 1-10 for fluency and grammatical accuracy (10 = flawless, native-like speed; 1 = barely intelligible).",
      'List genuine grammar, vocabulary or expression mistakes as objects {error, type, correction, explanation}; "type" must be one of "grammar", "vocabulary", "expression". If the utterance was clean, return an empty array.',
      "c1_rephrase: a natural, smooth C1-level way to express the same idea the way a native speaker would say it.",
      "feedback: one short, encouraging, concrete tip for rapid-fire speaking.",
      "vocab: 3-6 items worth learning from this attempt, as {said, better, why}. 'said' is the learner's own short fragment (quote it as spoken), 'better' is the natural C1-level way to say that, 'why' is a one-line explanation of what changed. Include awkward-but-grammatical phrasing, not only hard errors. Return an empty array only if the attempt had nothing worth keeping.",
      "Respond ONLY with JSON exactly matching the requested schema.",
    ].join("\n");
  }

  /* One streamed generateContent call; resolves with the stitched JSON text.
     A silent stream is abandoned after IDLE_TIMEOUT_MS, a live one may run as
     long as it needs. Only a retired model (404 / "no longer available") or a
     stall is worth moving to another model id. */
  async function requestEvaluation(model, body, apiKey) {
    const ctrl = new AbortController();
    let abortReason = null;
    let idle = setTimeout(() => { abortReason = "idle"; ctrl.abort(); }, IDLE_TIMEOUT_MS);
    const hard = setTimeout(() => { abortReason = "total"; ctrl.abort(); }, TOTAL_TIMEOUT_MS);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { abortReason = "idle"; ctrl.abort(); }, IDLE_TIMEOUT_MS);
    };
    const cleanup = () => { clearTimeout(idle); clearTimeout(hard); };

    /* A timeout is reported with the model name and the reason, so the next
       report says what actually happened instead of "too long". */
    const timeoutFailure = () => {
      const failure = new Error(
        abortReason === "total"
          ? "Gemini ran past " + Math.round(TOTAL_TIMEOUT_MS / 1000) + " s on " + model + "."
          : "Gemini went quiet on " + model + " (no data for " + Math.round(IDLE_TIMEOUT_MS / 1000) + " s)."
      );
      failure.retryable = true;
      failure.skipSameModel = true;
      failure.timeout = true;
      return failure;
    };

    const url =
      geminiUrl(model).replace(":generateContent", ":streamGenerateContent") +
      "?alt=sse&key=" + encodeURIComponent(apiKey);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (netErr) {
      cleanup();
      if (ctrl.signal.aborted || (netErr && netErr.name === "AbortError")) throw timeoutFailure();
      const failure = new Error("Can't reach the Gemini service — check your internet and try again.");
      failure.retryable = true; // a dropped request is worth one more try
      throw failure;
    }

    if (!res.ok) {
      let raw = "";
      let message = friendlyGeminiHttpStatus(res.status);
      try {
        const err = await res.json();
        raw = (err && err.error && err.error.message) || "";
        if (raw && res.status !== 403 && res.status !== 401) message = "Gemini: " + raw;
      } catch (_) {}
      cleanup();
      const failure = new Error(message);
      failure.status = res.status;
      failure.retryNextModel =
        res.status === 404 || /no longer available|not found|not supported|deprecated/i.test(raw);
      /* Capacity spikes are temporary and route to different pools per model,
         so these are worth a quick retry and then the other model. */
      failure.retryable =
        res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504 ||
        /high demand|overloaded|try again later|UNAVAILABLE|RESOURCE_EXHAUSTED|capacity/i.test(raw);
      throw failure;
    }

    /* Server-sent events: each `data:` payload is a JSON chunk whose text
       parts concatenate into the final answer. Reasoning parts carry
       `thought: true` and must never enter the JSON we parse. */
    let text = "";
    const takeEvent = (payload) => {
      let json;
      try {
        json = JSON.parse(payload);
      } catch (_) {
        return;
      }
      const cand = json && json.candidates && json.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      parts.forEach((p) => {
        if (p && p.text && !p.thought) text += p.text;
      });
    };

    try {
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let dataLines = [];
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bump(); // data is flowing: the stream is alive
          buffer += decoder.decode(chunk.value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (line === "") {
              if (dataLines.length) { takeEvent(dataLines.join("\n")); dataLines = []; }
            } else if (line.indexOf("data:") === 0) {
              dataLines.push(line.slice(5).trim());
            }
          }
        }
        if (dataLines.length) takeEvent(dataLines.join("\n"));
      } else {
        takeEvent(await res.text()); // no ReadableStream in this webview
      }
    } catch (err) {
      if (ctrl.signal.aborted || (err && err.name === "AbortError")) throw timeoutFailure();
      throw err;
    } finally {
      cleanup();
    }

    if (!text) {
      const failure = new Error("Gemini returned no evaluation content.");
      failure.retryable = true;
      throw failure;
    }
    return text;
  }

  async function evaluateWithGemini(transcript, session) {
    const topic = session.topic;
    const apiKey = getApiKey();
    if (!apiKey) {
      state.evaluating = false;
      note("Missing API key — open settings ⚙️", true);
      resetStartButton();
      openSettings();
      return;
    }
    if (navigator.onLine === false) {
      state.evaluating = false;
      note("No internet connection — evaluation needs to reach Gemini.", true, 4200);
      resetStartButton();
      return;
    }

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: buildPrompt(topic, transcript, session.elapsedSec) }],
        },
      ],
      generationConfig: {
        /* no sampling knobs: Gemini 3.x ignores/removes them, the schema is
           what keeps the answer machine-readable.
           "low" thinking keeps a short evaluation quick: 3.8 Flash defaults to
           "medium", which is what made replies outlast the HTTP timeout. */
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
      },
    };

    try {
      /* Two models × two attempts. A silent stream skips the second try on the
         same id (that model is not coming back), a busy one gets a quick
         retry, and a dead key or a bad request fails immediately. */
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let text = null;
      let lastError = null;
      for (let i = 0; i < GEMINI_MODELS.length && !text; i++) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            text = await requestEvaluation(GEMINI_MODELS[i], body, apiKey);
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            if (!err) throw err;
            if (!err.retryable && !err.retryNextModel) throw err;
            if (err.skipSameModel) break; // no point waiting twice for a silent model
            if (err.retryable && attempt === 0) {
              await sleep(650);
              continue;
            }
            break; // out of patience for this model: try the next id
          }
        }
      }
      if (!text) throw lastError;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        throw new Error("Gemini's reply wasn't valid JSON — try again.");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Gemini's reply was empty — try again.");
      }

      renderScorecard(sanitizeEvaluation(parsed), transcript, session);
    } catch (err) {
      const msg =
        err && err.name === "AbortError"
          ? "The evaluation was interrupted — try again."
          : err && err.message
          ? err.message
          : String(err);
      /* Name what happened (timeout, busy model, bad key) and leave the line up
         until the next attempt instead of flashing it. */
      if (err && (err.timeout || err.retryable)) {
        note(msg + " Both models were tried — give it another go in a moment.", true, 0);
      } else {
        note(msg, true, 5200);
      }
    } finally {
      stopEvalTicker();
      state.evaluating = false;
      resetStartButton();
    }
  }

  function friendlyGeminiHttpStatus(status) {
    if (status === 400) return "Gemini rejected the request — your API key may be malformed. Check settings ⚙️.";
    if (status === 401 || status === 403) return "API key invalid or unauthorized — re-save it in settings ⚙️.";
    if (status === 404) return "Model unavailable right now — try again later.";
    if (status === 429) return "Rate limit reached — wait a moment and try again.";
    if (status >= 500) return "Gemini had a server error (" + status + "). Try again shortly.";
    return "Gemini API error (" + status + ").";
  }

  /* Defensive validation of the model's JSON: clamp the score, keep only
     well-formed mistake objects, and force strings everywhere. */
  function sanitizeEvaluation(result) {
    const str = (v, max) => {
      const s = v == null ? "" : String(v);
      return s.slice(0, max);
    };
    const mistakeTypes = { grammar: 1, vocabulary: 1, expression: 1 };
    const mistakes = Array.isArray(result.mistakes)
      ? result.mistakes
          .filter((m) => m && typeof m === "object" && !Array.isArray(m))
          .slice(0, 8)
          .map((m) => ({
            error: str(m.error, 200),
            type: mistakeTypes[m.type] ? m.type : "",
            correction: str(m.correction, 200),
            explanation: str(m.explanation, 300),
          }))
      : [];
    /* The vocabulary log is built from this, so it is validated as strictly as
       the score: a fragment without a C1 version is useless as a card. */
    const vocab = Array.isArray(result.vocab)
      ? result.vocab
          .filter((v) => v && typeof v === "object" && !Array.isArray(v))
          .slice(0, 6)
          .map((v) => ({
            said: str(v.said, 240),
            better: str(v.better, 240),
            why: str(v.why, 300),
          }))
          .filter((v) => v.better)
      : [];
    let score = Number(result.score);
    if (!isFinite(score)) score = 5;
    return {
      score: Math.max(1, Math.min(10, Math.round(score))),
      mistakes: mistakes,
      c1_rephrase: str(result.c1_rephrase, 400),
      feedback: str(result.feedback, 300),
      vocab: vocab,
    };
  }

  /* ────────────── Scorecard ────────────── */
  const scoreTitles = {
    10: "Flawless machine. Nerves of steel.",
    9: "Near-native flow. Beautiful.",
    8: "Strong and steady. Lovely pace.",
    7: "Solid burst — small cracks to polish.",
    6: "Getting there — smoother next round.",
    5: "Mid-flight. Keep the words flowing.",
    4: "Rusty, not broken — repeat round.",
    3: "Hesitant start. Keep the words coming.",
    2: "Bumpy, but you spoke. That counts.",
    1: "Mic drop? Not yet — one more try.",
  };

  function renderScorecard(result, transcript, session) {
    const score = result.score; // already clamped by sanitizeEvaluation

    els.scoreValue.textContent = String(score);
    els.scoreTitle.textContent = scoreTitles[score] || "Your score";

    els.heardText.textContent = "\u201C" + transcript + "\u201D";

    saveHistoryRecord(result, score, transcript, session);
    state.lastResult = { score: score };

    /* Design chrome: the topic line under the title and the session id. */
    const topicLine = String((session && session.topic) || "").replace(/\s+/g, " ").trim();
    const secs = (session && session.elapsedSec) || 0;
    if (els.scoreSubtitle) {
      els.scoreSubtitle.textContent = topicLine
        ? topicLine + "  ·  " + secs + " seconds"
        : secs + " seconds";
    }
    if (els.feedbackSession) {
      els.feedbackSession.textContent = "SESSION " + String(loadHistory().length).padStart(3, "0");
    }
    vocabAddedThisAttempt = collectVocabFromResult(result, transcript, session);

    const mistakes = Array.isArray(result.mistakes) ? result.mistakes : [];
    els.mistakesList.innerHTML = "";
    const mistakesLabel = els.mistakesSection.querySelector(".card-label");
    if (!mistakes.length) {
      if (mistakesLabel) mistakesLabel.textContent = "02  /  REFINEMENTS · CLEAN BURST";
    } else {
      if (mistakesLabel) {
        mistakesLabel.textContent =
          "02  /  " + (mistakes.length === 1 ? "ONE REFINEMENT" : mistakes.length + " SMALL REFINEMENTS");
      }
      mistakes.slice(0, 8).forEach((m) => {
        const li = document.createElement("li");
        li.innerHTML =
          (m.type ? '<span class="m-tag">' + escapeHtml(m.type) + "</span>" : "") +
          '<span class="m-err">' + escapeHtml(m.error || "?") + "</span>" +
          ' → <span class="m-fix">' + escapeHtml(m.correction || "?") + "</span>" +
          '<span class="m-why">' + escapeHtml(m.explanation || "") + "</span>";
        els.mistakesList.appendChild(li);
      });
    }

    els.c1Text.textContent = result.c1_rephrase || "—";
    els.feedbackText.textContent = result.feedback || "—";

    /* The log fills itself before this screen appears — the line only reports
       what happened, there is nothing to press. */
    els.saveC1Hint.textContent = vocabAddedThisAttempt
      ? "Auto-saved → Vocabulary · " + vocabAddedThisAttempt +
        (vocabAddedThisAttempt === 1 ? " card" : " cards")
      : "Vocabulary was already up to date";

    showScoreScreen();
  }

  /* ─────────── Session history (localStorage + trend chart) ─────────── */

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, HISTORY_MAX)));
    } catch (_) {}
  }

  function saveHistoryRecord(result, score, transcript, session) {
    /* topic/transcript come from the captured session snapshot — NOT from
       state — so a “New topic” click during the evaluation can never save a
       mismatched record. */
    const record = {
      t: Date.now(),
      topic: String((session && session.topic) || ""),
      transcript: String(transcript || "").slice(0, 400),
      score: score,
      c1: String(result.c1_rephrase || "").slice(0, 400),
      feedback: String(result.feedback || "").slice(0, 300),
      mistakes: (Array.isArray(result.mistakes) ? result.mistakes : [])
        .slice(0, 6)
        .map((m) => ({
          error: String((m && m.error) || ""),
          correction: String((m && m.correction) || ""),
          type: String((m && m.type) || ""),
        })),
    };
    const history = loadHistory();
    history.unshift(record);
    saveHistory(history);
    renderStreakChip(loadHistory());
  }

  function goHistory() {
    if (state.recording || state.evaluating) return;
    renderHistory(loadHistory());
    hideAllScreens();
    els.screenHistory.classList.remove("hidden");
    setNav("history");
  }

  function goBackFromHistory() {
    clearHistoryButtonArmed();
    els.screenHistory.classList.add("hidden");
    if (state.lastResult) showScoreScreen();
    else showFlowScreen();
  }

  function renderHistory(history) {
    if (!history.length) {
      els.historyEmpty.classList.remove("hidden");
      els.historyStats.classList.add("hidden");
      els.chartSection.classList.add("hidden");
      els.historyList.innerHTML = "";
      return;
    }

    els.historyEmpty.classList.add("hidden");
    els.historyStats.classList.remove("hidden");

    // ── stats
    const scores = history.map((h) => h.score);
    els.sTotal.textContent = String(history.length);
    els.sBest.textContent = String(Math.max.apply(null, scores));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    els.sAvg.textContent = avg.toFixed(1);

    // ── trend chart (oldest → newest, up to last 20)
    renderTrendChart(history.slice(0, TREND_MAX).reverse(), avg);

    // ── attempt list
    els.historyList.innerHTML = "";
    /* The design shows the three most recent attempts, and the page never
       scrolls — the list is capped to what fits. */
    history.slice(0, 3).forEach((h) => {
      const li = document.createElement("li");
      li.className = "history-item";
      const mistakeCount = h.mistakes && h.mistakes.length ? h.mistakes.length : 0;
      li.innerHTML =
        '<div class="h-head">' +
          '<span class="h-score">' + h.score + "</span>" +
          '<div class="h-meta">' +
            '<div class="h-topic">' + escapeHtml(h.topic) + "</div>" +
            '<div class="h-date">' + formatWhen(h.t) +
              " · " + mistakeCount + (mistakeCount === 1 ? " mistake" : " mistakes") + "</div>" +
          "</div>" +
        "</div>";
      els.historyList.appendChild(li);
    });
  }

  function mistakeLinesHtml(mistakes) {
    if (!mistakes || !mistakes.length) return '<p class="h-mist">No mistakes noted — clean burst!</p>';
    return (
      '<p class="h-mist">' +
      mistakes
        .map(function (m) {
          return "<b>" + escapeHtml(m.error || "") + "</b> → " + escapeHtml(m.correction || "") +
            (m.type ? ' <span class="g">[' + escapeHtml(m.type) + ']</span>' : "");
        })
        .join("<br/>") +
      "</p>"
    );
  }

  function formatWhen(t) {
    const d = new Date(t);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return "Today " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const yest = new Date(today.getTime() - 86_400_000);
    if (d.toDateString() === yest.toDateString()) return "Yesterday " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  /* Chart area: viewBox 320×150. y: score 1 → 117.5, score 10 → 12.5.
     x: evenly spread from 22 to 298 (padding for dot radius). */
  function renderTrendChart(recent, avg) {
    els.chartSection.classList.remove("hidden");
    els.trendPoints.innerHTML = "";

    const n = recent.length;
    if (n === 0) {
      els.trendLine.setAttribute("points", "");
      els.trendAvg.setAttribute("y1", "300"); els.trendAvg.setAttribute("y2", "300");
      return;
    }

    const y = (s) => 118 - (Math.max(0, Math.min(10, s)) / 10) * 112; // 0 → baseline

    if (els.chartAvg) els.chartAvg.textContent = avg.toFixed(1);

    /* Bars, as in the design: one per session, the newest one in brass. */
    const slot = 310 / n;
    const bw = Math.min(9, Math.max(4, slot * 0.55));
    recent.forEach((h, i) => {
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const height = Math.max(4, 118 - y(h.score));
      r.setAttribute("x", (5 + slot * i + (slot - bw) / 2).toFixed(1));
      r.setAttribute("y", (118 - height).toFixed(1));
      r.setAttribute("width", bw.toFixed(1));
      r.setAttribute("height", height.toFixed(1));
      r.setAttribute("rx", "2");
      r.setAttribute("class", i === n - 1 ? "bar current" : "bar");
      els.trendPoints.appendChild(r);
    });

    const yAvg = y(avg).toFixed(1);
    els.trendAvg.setAttribute("y1", yAvg);
    els.trendAvg.setAttribute("y2", yAvg);
  }

  /* Clear button needs a double tap (no confirm() in the iOS webview). */
  let clearArmed = false;
  let clearArmedTimer = null;
  function clearHistoryButtonArmed() {
    clearArmed = false;
    els.btnClearHistory.textContent = "Clear history";
    clearTimeout(clearArmedTimer);
  }

  els.btnClearHistory.addEventListener("click", () => {
    if (!clearArmed) {
      clearArmed = true;
      els.btnClearHistory.textContent = "Tap again to delete ALL";
      clearArmedTimer = setTimeout(clearHistoryButtonArmed, 3500);
      return;
    }
    localStorage.removeItem(HISTORY_KEY);
    state.lastResult = null;
    clearHistoryButtonArmed();
    renderHistory(loadHistory());
    renderStreakChip(loadHistory());   // the streak is derived from history
    note("History deleted", false, 1800);
  });

  els.btnHistory.addEventListener("click", goHistory);
  els.btnBackMain.addEventListener("click", goBackFromHistory);

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ────────────── Retry: same topic, immediately (no reading time) ────────────── */
  els.btnRetry.addEventListener("click", () => startSpeakingFlow(state.topic));

  /* ────────────── Daily streak (derived from saved sessions) ────────────── */

  function dayKey(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function computeStreak(history) {
    const daySet = new Set(history.map((h) => dayKey(new Date(h.t))));
    const today = dayKey(new Date());
    const yesterday = dayKey(new Date(Date.now() - 86_400_000));

    if (daySet.has(today)) {
      let current = 0;
      let cursor = new Date();
      while (daySet.has(dayKey(cursor))) {
        current += 1;
        cursor = new Date(cursor.getTime() - 86_400_000);
      }
      return { current: current, endedToday: true };
    }
    if (daySet.has(yesterday)) {
      let current = 0;
      let cursor = new Date(Date.now() - 86_400_000);
      while (daySet.has(dayKey(cursor))) {
        current += 1;
        cursor = new Date(cursor.getTime() - 86_400_000);
      }
      return { current: current, endedToday: false };
    }
    return { current: 0, endedToday: false };
  }

  function renderStreakChip(history) {
    const streak = computeStreak(history);
    let html;
    if (!streak.current) {
      html = "No streak yet";
    } else if (streak.endedToday) {
      html = streak.current + "-day streak";
    } else {
      html = streak.current + "-day streak today";
    }
    els.streakChip.innerHTML = html;
  }

  /* ────────────── Vocabulary & flashcards (localStorage) ────────────── */

  const flash = { deck: [], pos: 0, revealed: false };

  function loadVocab() {
    try {
      const arr = JSON.parse(localStorage.getItem(VOCAB_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveVocabList(arr) {
    try {
      localStorage.setItem(VOCAB_KEY, JSON.stringify(arr.slice(0, VOCAB_MAX)));
    } catch (_) {}
  }

  /* Cards are deduped by their C1 side: one improved phrase is one card, no
     matter how many attempts produced it. */
  function autoAddVocab(entries, topic) {
    const list = loadVocab();
    let added = 0;
    entries.forEach((v) => {
      const better = String((v && v.better) || "").trim();
      if (!better) return;
      if (list.some((e) => String(e.term || "").toLowerCase() === better.toLowerCase())) return;
      list.unshift({
        id: "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        term: better.slice(0, 240),
        said: String((v && v.said) || "").trim().slice(0, 240),
        definition: String((v && v.why) || "").trim().slice(0, 300),
        source: (v && v.source) || "auto",
        topic: String(topic || "").slice(0, 160),
        t: Date.now(),
        box: 0,   // 0 = still learning, 3 = learned
        seen: 0,
      });
      added += 1;
    });
    if (added) saveVocabList(list);
    return added;
  }

  /* Runs once per scorecard: Gemini's own vocabulary items plus the whole
     answer's C1 rephrasing become cards, so nothing is left for the learner
     to copy or press. */
  function collectVocabFromResult(result, transcript, session) {
    const entries = (Array.isArray(result.vocab) ? result.vocab : []).slice();
    if (result.c1_rephrase) {
      entries.push({
        said: transcript,
        better: result.c1_rephrase,
        why: "A natural C1 version of your whole answer.",
      });
    }
    return autoAddVocab(entries, session && session.topic);
  }

  let vocabAddedThisAttempt = 0;

  function openVocab() {
    if (state.recording || state.evaluating) return; // never hide a live attempt
    renderVocabScreen();
    hideAllScreens();
    els.screenVocab.classList.remove("hidden");
    setNav("vocabulary");
  }

  function renderVocabScreen() {
    buildFlashDeck();
    renderFlash();
  }

  /* A deck, not a list: exactly one card is on the table. Know-it is a swipe to
     the right, "study again" a swipe to the left, and the queue keeps the order
     the cards were collected in — the oldest first. */
  const SWIPE_THRESHOLD = 88;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function buildFlashDeck() {
    flash.deck = loadVocab()
      .slice()
      .sort((x, y) => (x.t || 0) - (y.t || 0))
      .map((e) => e.id);
    flash.pos = 0;
    flash.revealed = false;
  }

  function currentFlashEntry() {
    const id = flash.deck[flash.pos];
    return loadVocab().find((e) => e.id === id) || null;
  }

  function renderFlash() {
    const list = loadVocab();
    const total = list.length;
    const byId = new Map(list.map((e) => [e.id, e]));
    const queue = flash.deck.slice(flash.pos).map((id) => byId.get(id)).filter(Boolean);

    /* The card that just left stays in the air while the next one takes the
       table, so a swipe always ends in a card rather than a gap. */
    Array.prototype.forEach.call(
      els.flashDeck.querySelectorAll(".fcard:not([data-flying])"),
      (n) => n.remove()
    );

    const done = queue.length === 0;
    els.flashEmpty.classList.toggle("hidden", !done);
    els.flashEmpty.textContent = total
      ? "Every card seen, oldest first. Start another round to go again."
      : "Nothing here yet — finish one attempt and your vocabulary collects itself.";
    els.btnFlashRestart.classList.toggle("hidden", !done || total === 0);
    els.btnFlashAgain.classList.toggle("hidden", done);
    els.btnFlashGot.classList.toggle("hidden", done);
    els.flashHint.classList.toggle("hidden", total === 0);

    if (done) {
      els.flashProgress.textContent = total ? pad2(total) + " CARDS IN YOUR DECK" : "";
      return;
    }

    els.flashProgress.textContent = pad2(flash.deck.length) + " CARDS IN YOUR DECK";

    /* Three edges only: the cards behind carry no text, just depth. */
    const visible = queue.slice(0, 3);
    for (let depth = visible.length - 1; depth >= 0; depth -= 1) {
      els.flashDeck.appendChild(
        buildFlashCard(visible[depth], depth, flash.pos + depth, flash.deck.length)
      );
    }
  }

  function buildFlashCard(entry, depth, index, total) {
    const card = document.createElement("div");
    card.className = "fcard pos-" + depth;
    card.style.zIndex = String(20 - depth);
    if (depth > 0) return card;                      // an edge, not a card face

    /* Long phrases shrink so the card never spills over its footer. */
    const termLength = (entry.term || "").length;
    const termSize =
      termLength <= 60 ? 36 : termLength <= 100 ? 30 : termLength <= 150 ? 25 : termLength <= 220 ? 21 : 18;
    card.style.setProperty("--term-size", termSize + "px");
    if (flash.revealed) card.classList.add("revealed");
    card.innerHTML =
      '<div class="fcard-man">' +
        '<span class="fcard-step">' + pad2(index + 1) + "<i> / " + pad2(total) + "</i></span>" +
        '<div class="fcard-stamp got">Got it</div>' +
        '<div class="fcard-stamp again">Again</div>' +
      "</div>" +
      '<p class="fcard-term">' + escapeHtml(entry.term) + "</p>" +
      '<span class="instead-label">INSTEAD OF</span>' +
      (entry.said ? '<p class="fcard-said">“' + escapeHtml(entry.said) + "”</p>" : "") +
      '<p class="fcard-def">' + escapeHtml(entry.definition || "No note saved.") + "</p>" +
      '<div class="fcard-foot">' +
        '<span class="fcard-tap">Tap to see the explanation ↗</span>' +
      "</div>";
    attachCardGestures(card);
    return card;
  }

  /* ── Dragging the top card: horizontal commits, a tap reveals ── */
  let cardDrag = null;

  function attachCardGestures(card) {
    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      cardDrag = { card: card, x: e.clientX, y: e.clientY, dx: 0, moved: false };
      card.classList.add("dragging");
      try { card.setPointerCapture(e.pointerId); } catch (_) {}
    });

    card.addEventListener("pointermove", (e) => {
      if (!cardDrag || cardDrag.card !== card) return;
      const dx = e.clientX - cardDrag.x;
      const dy = e.clientY - cardDrag.y;
      cardDrag.dx = dx;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cardDrag.moved = true;
      if (!cardDrag.moved) return;
      card.style.transform =
        "translate(" + dx + "px, " + (dy * 0.14).toFixed(1) + "px) rotate(" + (dx * 0.03).toFixed(2) + "deg)";
      card.style.setProperty("--swipe", Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD).toFixed(2));
      card.classList.toggle("to-right", dx > 0);
      card.classList.toggle("to-left", dx < 0);
    });

    card.addEventListener("pointerup", () => finishCardDrag(true));
    card.addEventListener("pointercancel", () => finishCardDrag(false));
  }

  function finishCardDrag(commit) {
    const drag = cardDrag;
    if (!drag) return;
    cardDrag = null;
    const card = drag.card;
    card.classList.remove("dragging");

    if (!drag.moved) {                        // a tap, not a swipe
      flash.revealed = !flash.revealed;
      card.classList.toggle("revealed", flash.revealed);
      return;
    }

    if (commit && Math.abs(drag.dx) >= SWIPE_THRESHOLD) {
      swipeCard(drag.dx > 0 ? 1 : -1);
      return;
    }

    card.style.transform = "";                // not far enough: back to the table
    card.classList.remove("to-right", "to-left");
    card.style.setProperty("--swipe", "0");
  }

  function swipeCard(dir) {
    if (flash.pos >= flash.deck.length) return;
    const card = els.flashDeck.querySelector(".fcard.pos-0");
    if (card) {
      card.dataset.flying = "1";
      card.classList.remove("dragging");
      card.style.zIndex = "30";
      card.style.transition = "transform 320ms var(--ease-out), opacity 300ms ease-out";
      card.style.transform = "translate(" + dir * 130 + "%, -4%, 0) rotate(" + dir * 15 + "deg)";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 360);
    }
    flash.revealed = false;
    gradeFlash(dir > 0);
  }

  function gradeFlash(known) {
    const entry = currentFlashEntry();
    if (!entry) return;
    const list = loadVocab();
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      list[i].seen = (list[i].seen || 0) + 1;
      list[i].box = known ? Math.min(3, (list[i].box || 0) + 1) : 0;
      list[i].last = Date.now();
      saveVocabList(list);
    }
    if (!known) flash.deck.push(entry.id); // comes back later in this round
    flash.pos += 1;
    flash.revealed = false;
    renderFlash();
  }

  els.btnVocab.addEventListener("click", openVocab);
  els.btnVocabBack.addEventListener("click", goHome);
  if (els.btnNavPractice) els.btnNavPractice.addEventListener("click", goHome);
  if (els.btnSpeakingBack) {
    els.btnSpeakingBack.addEventListener("click", () => {
      if (state.recording && state.session) {
        state.session.requestStop("Attempt ended — nothing was saved.");
      } else {
        goHome();
      }
    });
  }
  els.btnScoreBack.addEventListener("click", goHome);

  els.btnFlashGot.addEventListener("click", () => swipeCard(1));
  els.btnFlashAgain.addEventListener("click", () => swipeCard(-1));
  els.btnFlashRestart.addEventListener("click", () => {
    buildFlashDeck();
    renderFlash();
  });

  /* ────────────── Init ────────────── */
  resetTimerUI();
  resetStartButton();
  renderStreakChip(loadHistory());
})();
