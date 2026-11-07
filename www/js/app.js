/* ════════════════════════════════════════════════════════════════
   10-Second English Fluency Coach — app logic
   Flow: random topic → strict 10s speech capture → auto-stop →
        Gemini 2.5 Flash evaluation (structured JSON) → scorecard
   ════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ────────────── Constants & state ────────────── */
  const KEY_STORAGE = "gemini_api_key";          // localStorage key
  const MODE_KEY = "practice_mode";              // localStorage key (seconds: 10 | 30 | 60)
  const ALLOWED_MODES = [10, 30, 60];
  const GEMINI_ENDPOINT =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const RESP_TIME_LIMIT_MS = 20_000;
  const HISTORY_KEY = "session_history";    // localStorage key
  const HISTORY_MAX = 100;                  // stored attempts cap
  const TREND_MAX = 20;                     // points shown in the trend chart

  const state = {
    topic: "",
    recording: false,
    evaluating: false,
    lastResult: null,
    session: null, // live “pointer” to the active recording session object
    modeSec: clampMode(loadModeSec()),
    durationMs: 10_000,
    ring: null, // active rAF handle
  };

  /* ────────────── Element handles ────────────── */
  const $ = (id) => document.getElementById(id);
  const els = {
    btnNewTopic: $("btn-new-topic"),
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
    toast: $("toast"),
    /* practice modes + streak */
    modeRow: $("mode-row"),
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
  };

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 → 326.73
  els.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.scoreArc.style.strokeDasharray = String(RING_CIRCUMFERENCE);

  /* Native detection: inside Capacitor iOS the native runtime injects the
     window.Capacitor bridge, exposing installed plugins on Capacitor.Plugins. */
  const cap = window.Capacitor || null;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const nativeSpeech =
    isNative && cap.Plugins && cap.Plugins.SpeechRecognition ? cap.Plugins.SpeechRecognition : null;

  /* ────────────── Tiny helpers ────────────── */
  let toastTimer = null;
  function toast(msg, isErr = false, ms = 3200) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("err", isErr);
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), ms);
  }

  function getApiKey() {
    return (localStorage.getItem(KEY_STORAGE) || "")
      .trim()
      .replace(/^[\s"'`]+|[\s"'`]+$/g, ""); // tolerate a key pasted with quotes
  }

  const MIC_ICON =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><path d="M12 19v3"></path></svg>';
  const recordingLabel =
    '<span class="btn-spinner"></span><span>Recording… speak now!</span>';
  const evaluatingLabel = '<span class="btn-spinner"></span><span>Evaluating with Gemini…</span>';

  function setStartButton(label, disabled) {
    els.btnStart.innerHTML = label;
    els.btnStart.disabled = disabled;
  }

  function buildStartLabel() {
    return MIC_ICON + '<span>Start ' + state.modeSec + 's Speaking</span>';
  }

  function resetStartButton() {
    els.btnStart.classList.remove("recording");
    setStartButton(buildStartLabel(), !state.topic);
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
  els.btnNewTopic.addEventListener("click", pickNewTopic);
  els.btnNewTopic2.addEventListener("click", pickNewTopic);

  function pickNewTopic() {
    // Never change the topic mid-session: the recorder and the pending
    // evaluation both reference the captured topic.
    if (state.recording || state.evaluating) {
      toast("Finish the current attempt first! ⏳", true, 2200);
      return;
    }
    state.topic = getRandomTopic(state.topic);
    els.topicText.textContent = state.topic;
    els.topicText.classList.remove("placeholder");
    showFlowScreen();
    resetStartButton();

    // fresh animation for the topic swap
    els.topicText.style.animation = "none";
    void els.topicText.offsetWidth;
    els.topicText.style.animation = "topicIn .45s cubic-bezier(.2,.9,.3,1.2)";
  }

  function showFlowScreen() {
    els.screenScore.classList.add("hidden");
    els.screenFlow.classList.remove("hidden");
  }

  function showScoreScreen() {
    els.screenFlow.classList.add("hidden");
    els.screenScore.classList.remove("hidden");
  }

  const style = document.createElement("style");
  style.textContent =
    "@keyframes topicIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }";
  document.head.appendChild(style);

  /* ────────────── The strict 10-second timer ────────────── */
  let timerCancel = null;

  function startTimer(onDone) {
    const started = performance.now();
    const TOTAL = state.durationMs;
    let stopped = false;
    let lastSecond = -1;
    let warned = false;
    let closing = false;

    /* The sweep is a single CSS transition with the exact duration instead of a
       stroke write on every frame: the ring no longer costs any script, and it
       stays smooth even when the main thread is busy with speech events. */
    els.ringProgress.style.transition = "none";
    els.ringProgress.style.strokeDashoffset = "0";
    void els.ringProgress.getBoundingClientRect();
    els.ringProgress.style.transition = "stroke-dashoffset " + TOTAL + "ms linear";
    els.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);

    function frame(now) {
      if (stopped) return;
      const elapsed = Math.min(now - started, TOTAL);
      const remaining = TOTAL - elapsed;

      const sec = Math.ceil(remaining / 1000);
      if (sec !== lastSecond) {           // one write per second, not per frame
        els.timerSeconds.textContent = String(sec);
        lastSecond = sec;
      }
      if (!warned && remaining <= 3000) { els.timerSeconds.classList.add("warn"); warned = true; }
      if (!closing && remaining <= 1000) { els.timerWrap.classList.add("final"); closing = true; }

      if (elapsed >= TOTAL) {
        stopped = true;
        state.ring = null;
        onDone();
        return;
      }
      state.ring = requestAnimationFrame(frame);
    }

    state.ring = requestAnimationFrame(frame);
    timerCancel = () => {
      stopped = true;
      if (state.ring) cancelAnimationFrame(state.ring);
      state.ring = null;
      els.ringProgress.style.transition = "none";
    };
  }

  function cancelTimer() {
    if (timerCancel) timerCancel();
    timerCancel = null;
  }

  function resetTimerUI() {
    cancelTimer();
    els.ringProgress.style.transition = "none";
    els.ringProgress.style.strokeDashoffset = "0";
    els.timerSeconds.textContent = String(state.modeSec);
    els.timerSeconds.classList.remove("warn");
    els.timerWrap.classList.remove("final");
    els.liveTranscript.textContent = "Listening…";
    els.liveTranscript.classList.remove("active");
  }

  /* ────────────── Speech capture (native iOS ⇄ web) ────────────── */

  /* beginSpeechCapture resolves after listening has started and returns
     a stop() function to end the capture immediately. */
  async function beginSpeechCapture(onPartial, onError) {
    return nativeSpeech ? captureNativeSpeech(onPartial, onError) : captureWebSpeech(onPartial, onError);
  }

  async function captureNativeSpeech(onPartial, onError) {
    const SR = nativeSpeech;
    try {
      let has = false;
      try {
        const p = await SR.hasPermission();
        has = !!p.hasPermission;
      } catch (_) {
        try {
          const p = await SR.checkPermissions();
          has = p.speechRecognition === "granted" && p.microphone === "granted";
        } catch (_) {
          has = false;
        }
      }
      if (!has) {
        const granted = await requestSpeechPermission();
        if (!granted) {
          onError("Microphone / Speech access denied. Enable it in iOS Settings → Privacy → Speech Recognition & Microphone.");
          return () => {};
        }
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

      await SR.start({
        language: "en-US",
        maxResults: 1,
        prompt: "Speak for exactly " + state.modeSec + " seconds!",
        partialResults: true,
        popup: false,
      });
      return () => {};
    } catch (err) {
      onError("Speech recognition failed to start: " + (err && err.message ? err.message : String(err)));
      return () => {};
    }
  }

  async function requestSpeechPermission() {
    try {
      const perm = await nativeSpeech.requestPermission();
      return perm.speechRecognition === "granted" && perm.microphone === "granted";
    } catch (_) {
      return false;
    }
  }

  async function captureWebSpeech(onPartial, onError) {
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
        toast("Speech service unreachable (network) — this attempt may be incomplete", true, 3200);
        return;
      }
      toast("Speech warning: " + kind, true, 2400);
    };

    rec.onend = () => {
      // Early end (silence/browser policy): restart ONLY while the session is
      // live and the failure was not fatal. After the 10s cutoff, detached is
      // true and this becomes a no-op.
      if (!detached && !fatal && state.recording) {
        try { rec.start(); } catch (_) {}
      }
    };

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

  els.btnStart.addEventListener("click", startSpeakingFlow);

  async function startSpeakingFlow() {
    if (state.recording || state.evaluating) return;

    if (!state.topic) {
      toast("Draw a topic first! 🎲", true);
      return;
    }
    if (!getApiKey()) {
      toast("Save your Gemini API key first ⚙️", true);
      openSettings();
      return;
    }

    const session = {
      topic: state.topic,
      durationSec: state.modeSec,
      transcript: "",
      error: null,
    };
    state.recording = true;
    state.session = session;
    resetTimerUI();
    els.timerSection.classList.remove("hidden");
    els.liveTranscript.classList.add("active");
    els.liveTranscript.textContent = "Listening…";
    els.btnStart.classList.add("recording");
    setStartButton(recordingLabel, true);

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
    const onError = (err) => {
      if (state.session !== session) return;
      if (!session.error) session.error = err;
    };

    let stopCapture = () => {};
    try {
      stopCapture = await beginSpeechCapture(onPartial, onError);
    } catch (err) {
      onError("Speech capture crashed: " + (err && err.message ? err.message : String(err)));
    }

    // Session may already be dead (fatal error, or the cutoff raced the start).
    if (state.session !== session) {
      try { stopCapture(); } catch (_) {}
      return;
    }
    if (session.error) {
      await killCaptureRunnable();
      await teardownSession(session);
      resetStartButton();
      toast(session.error, true, 5000);
      return;
    }

    // Strict hard cutoff at exactly the selected duration — regardless of state.
    await new Promise((resolve) => startTimer(resolve));
    if (state.session !== session) return; // aborted meanwhile

    // ── Cutoff: stop the mic, then DRAIN. iOS/Safari can flush the final
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
    cancelTimer();
    resetTimerUI();
    els.timerSection.classList.add("hidden");
    state.recording = false;
    if (state.session === session) state.session = null; // its events are dead from here on
  }

  async function finishSpeaking(session) {
    resetStartButton();

    if (session.error) {
      toast(session.error, true, 5000);
      return;
    }

    const final = (session.transcript || "").trim();

    if (!final || final.replace(/[^a-z0-9']/gi, "").length < 4) {
      toast("No speech detected in the " + session.durationSec + "s window — try again! 🎤", true, 4500);
      els.liveTranscript.textContent = "";
      return;
    }

    setStartButton(evaluatingLabel, true);
    state.evaluating = true;
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
    },
    required: ["score", "mistakes", "c1_rephrase", "feedback"],
  };

  function buildPrompt(topic, transcript) {
    const dur = state.modeSec;
    return [
      "You are an expert English fluency coach helping a learner build C1-level spontaneous speaking.",
      "The learner was given a random topic and had exactly " + dur + " seconds to speak off the top of their head, without preparation.",
      "",
      'TOPIC: "' + topic + '"',
      'WHAT THE LEARNER SAID (speech-to-text of the ' + dur + '-second attempt): "' + transcript + '"',
      "",
      "Evaluate this " + dur + "-second speaking burst. Judge fluency, word choice, grammar accuracy and how well they developed the thought in the given window — do NOT penalise brevity itself.",
      "Score 1-10 for fluency and grammatical accuracy (10 = flawless, native-like speed; 1 = barely intelligible).",
      'List genuine grammar, vocabulary or expression mistakes as objects {error, type, correction, explanation}; "type" must be one of "grammar", "vocabulary", "expression". If the utterance was clean, return an empty array.',
      "c1_rephrase: a natural, smooth C1-level way to express the same idea the way a native speaker would say it.",
      "feedback: one short, encouraging, concrete tip for rapid-fire speaking.",
      "Respond ONLY with JSON exactly matching the requested schema.",
    ].join("\n");
  }

  async function evaluateWithGemini(transcript, session) {
    const topic = session.topic;
    const apiKey = getApiKey();
    if (!apiKey) {
      state.evaluating = false;
      toast("Missing API key — open settings ⚙️", true);
      resetStartButton();
      openSettings();
      return;
    }
    if (navigator.onLine === false) {
      state.evaluating = false;
      toast("No internet connection — evaluation needs to reach Gemini.", true, 4200);
      resetStartButton();
      return;
    }

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: buildPrompt(topic, transcript) }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESP_TIME_LIMIT_MS);

    try {
      let res;
      try {
        res = await fetch(GEMINI_ENDPOINT + "?key=" + encodeURIComponent(apiKey), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (netErr) {
        if (netErr && netErr.name === "AbortError") throw netErr;
        throw new Error("Can't reach the Gemini service — check your internet and try again.");
      }

      if (!res.ok) {
        let message = friendlyGeminiHttpStatus(res.status);
        try {
          const err = await res.json();
          if (err && err.error && err.error.message && res.status !== 403 && res.status !== 401) {
            message = "Gemini: " + err.error.message;
          }
        } catch (_) {}
        throw new Error(message);
      }

      let data;
      try {
        data = await res.json();
      } catch (_) {
        throw new Error("Gemini returned a malformed response body.");
      }

      const candidate = data && data.candidates && data.candidates[0];
      if (candidate && candidate.finishReason && candidate.finishReason !== "STOP") {
        throw new Error(
          candidate.finishReason === "SAFETY"
            ? "Gemini blocked this evaluation on safety grounds. Try a friendlier phrasing."
            : "Gemini stopped early (" + candidate.finishReason + "). Try again."
        );
      }

      const text =
        candidate &&
        candidate.content &&
        candidate.content.parts &&
        candidate.content.parts[0] &&
        candidate.content.parts[0].text;

      if (!text) throw new Error("Gemini returned no evaluation content.");

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
          ? "Gemini took too long to answer. Try again."
          : err && err.message
          ? err.message
          : String(err);
      toast(msg, true, 5200);
    } finally {
      clearTimeout(timeout);
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
    let score = Number(result.score);
    if (!isFinite(score)) score = 5;
    return {
      score: Math.max(1, Math.min(10, Math.round(score))),
      mistakes: mistakes,
      c1_rephrase: str(result.c1_rephrase, 400),
      feedback: str(result.feedback, 300),
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
    els.scoreArc.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    els.scoreArc.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - score / 10));

    els.heardText.textContent = "\u201C" + transcript + "\u201D";

    saveHistoryRecord(result, score, transcript, session);
    state.lastResult = { score: score };

    const mistakes = Array.isArray(result.mistakes) ? result.mistakes : [];
    els.mistakesList.innerHTML = "";
    if (!mistakes.length) {
      els.mistakesSection.querySelector(".card-label").textContent = "MISTAKES — NONE. CLEAN BURST! 🎉";
    } else {
      els.mistakesSection.querySelector(".card-label").textContent = "MISTAKES";
      const tagColors = {
        grammar: "rgba(251,113,133,.2)",
        vocabulary: "rgba(34,211,238,.2)",
        expression: "rgba(167,139,250,.2)",
      };
      mistakes.slice(0, 8).forEach((m) => {
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="m-err">' + escapeHtml(m.error || "?") + "</span>" +
          ' → <span class="m-fix">' + escapeHtml(m.correction || "?") + "</span>" +
          (m.type
            ? ' <span class="m-tag" style="background:' + (tagColors[m.type] || "rgba(148,163,184,.2)") + '">' +
              escapeHtml(m.type) + "</span>"
            : "") +
          '<span class="m-why">' + escapeHtml(m.explanation || "") + "</span>";
        els.mistakesList.appendChild(li);
      });
    }

    els.c1Text.textContent = result.c1_rephrase || "—";
    els.feedbackText.textContent = result.feedback || "—";

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
    const history = loadHistory();
    renderHistory(history);
    els.screenFlow.classList.add("hidden");
    els.screenScore.classList.add("hidden");
    els.screenHistory.classList.remove("hidden");
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
    history.forEach((h) => {
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
        "</div>" +
        '<details class="h-details"><summary>Coach notes ＋</summary>' +
          '<p class="h-tip">💡 ' + escapeHtml(h.feedback || "") + "</p>" +
          '<p class="h-c1">' + escapeHtml(h.c1 || "") + "</p>" +
          '<p class="h-heard">“' + escapeHtml(h.transcript || "") + "”</p>" +
          mistakeLinesHtml(h.mistakes) +
        "</details>";
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

    const x = (i) => (n === 1 ? 160 : 22 + (i * 276) / (n - 1));
    const y = (s) => 117.5 - ((s - 1) / 9) * 105; // score 1..10 → 117.5..12.5

    const pts = recent.map((h, i) => x(i) + "," + y(h.score).toFixed(1));
    els.trendLine.setAttribute("points", pts.join(" "));

    // average line
    const yAvg = y(avg).toFixed(1);
    els.trendAvg.setAttribute("y1", yAvg);
    els.trendAvg.setAttribute("y2", yAvg);

    recent.forEach((h, i) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", x(i).toFixed(1));
      c.setAttribute("cy", y(h.score).toFixed(1));
      c.setAttribute("r", "4");
      c.setAttribute("class", "trend-point");
      els.trendPoints.appendChild(c);
    });
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
    toast("History deleted", false, 1800);
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

  /* ────────────── Retry on same topic ────────────── */
  els.btnRetry.addEventListener("click", () => {
    showFlowScreen();
    resetStartButton();
    els.liveTranscript.textContent = "";
  });

  /* ────────────── Practice modes (10 / 30 / 60 seconds) ────────────── */

  function loadModeSec() {
    const n = parseInt(localStorage.getItem(MODE_KEY), 10);
    return isNaN(n) ? 10 : n;
  }

  function clampMode(sec) {
    return ALLOWED_MODES.includes(sec) ? sec : 10;
  }

  function applyPracticeMode(sec, persist) {
    state.modeSec = clampMode(sec);
    state.durationMs = state.modeSec * 1000;

    els.modeRow.querySelectorAll(".mode-pill").forEach((pill) => {
      pill.classList.toggle("active", String(state.modeSec) === pill.dataset.sec);
    });

    if (persist) {
      try { localStorage.setItem(MODE_KEY, String(state.modeSec)); } catch (_) {}
    }

    if (!state.recording && !state.evaluating) resetTimerUI();
    resetStartButton();
  }

  els.modeRow.addEventListener("click", (e) => {
    const pill = e.target.closest(".mode-pill");
    if (!pill || state.recording || state.evaluating) return;
    applyPracticeMode(parseInt(pill.dataset.sec, 10), true);
  });

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

  /* ────────────── Init ────────────── */
  state.durationMs = state.modeSec * 1000;
  applyPracticeMode(state.modeSec, false);
  renderStreakChip(loadHistory());
})();
