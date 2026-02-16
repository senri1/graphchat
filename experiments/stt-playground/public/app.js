const providerEl = document.getElementById('provider');
const languageEl = document.getElementById('language');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const interimEl = document.getElementById('interim');
const referenceEl = document.getElementById('reference');
const metricsEl = document.getElementById('metrics');
const historyRowsEl = document.getElementById('historyRows');
const exportBtn = document.getElementById('exportBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const hotkeyValueEl = document.getElementById('hotkeyValue');
const setHotkeyBtn = document.getElementById('setHotkeyBtn');
const clearHotkeyBtn = document.getElementById('clearHotkeyBtn');

const STORE_KEY = 'stt-playground-history-v1';
const SETTINGS_KEY = 'stt-playground-settings-v1';
const DEFAULT_PTT_KEY_CODE = 'Space';
const GROQ_PSEUDO_REALTIME_CHUNK_MS = 950;

const state = {
  mode: 'idle',
  recognition: null,
  runStartedAt: 0,
  firstResultAt: null,
  finalText: '',
  history: [],

  hasOpenAIKey: false,
  hasGroqKey: false,

  openaiConfiguredModel: '',
  openaiActiveModel: '',
  openaiPc: null,
  openaiDc: null,
  openaiStream: null,
  openaiSegments: new Map(),
  openaiCommitCounter: 0,
  openaiLastSegmentUpdateAt: 0,

  groqConfiguredTurboModel: '',
  groqConfiguredQualityModel: '',
  groqConfiguredPseudoModel: '',
  groqRecorder: null,
  groqStream: null,
  groqChunks: [],
  groqProvider: '',
  groqPseudoSegmentTimer: null,
  groqPseudoStopRequested: false,
  groqPseudoPendingUploads: Promise.resolve(),
  groqPseudoLastModelUsed: '',
  groqPseudoHadChunkError: false,
  groqPseudoSessionId: 0,

  pttKeyCode: DEFAULT_PTT_KEY_CODE,
  pttKeyLabel: 'Space',
  hotkeyCaptureArmed: false,
  hotkeyPressed: false,
  hotkeyStartPending: false,
};

function nowMs() {
  return Math.round(performance.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(text, type = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.type = type;
}

function updateHotkeyButtonState() {
  const idle = state.mode === 'idle';
  setHotkeyBtn.disabled = !idle && !state.hotkeyCaptureArmed;
  clearHotkeyBtn.disabled = !idle || !state.pttKeyCode || state.hotkeyCaptureArmed;
}

function setControlsRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  providerEl.disabled = running;
  updateHotkeyButtonState();
}

function setControlsConnecting() {
  startBtn.disabled = true;
  stopBtn.disabled = true;
  providerEl.disabled = true;
  updateHotkeyButtonState();
}

function isGroqBatchProvider(provider) {
  return provider === 'groq-turbo' || provider === 'groq-quality';
}

function isGroqPseudoRealtimeProvider(provider) {
  return provider === 'groq-pseudo-realtime';
}

function parseProviderLabel(provider) {
  if (provider === 'web-speech') return 'Web Speech';
  if (provider === 'openai') return 'OpenAI Realtime';
  if (provider === 'groq-turbo') return 'Groq Turbo';
  if (provider === 'groq-quality') return 'Groq Quality';
  if (provider === 'groq-pseudo-realtime') return 'Groq Pseudo-Realtime';
  return provider;
}

function hotkeyLabelFromCode(code) {
  if (!code || typeof code !== 'string') return '';
  if (code === 'Space') return 'Space';
  if (code === 'Escape') return 'Escape';
  if (code === 'Enter') return 'Enter';
  if (code === 'Tab') return 'Tab';
  if (code === 'Backspace') return 'Backspace';
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Numpad ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code;
  return code;
}

function normalizeWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function wordErrorRate(reference, hypothesis) {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (!ref.length) return null;

  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  const edits = dp[rows - 1][cols - 1];
  return edits / ref.length;
}

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
  return `${Math.max(0, Math.round(ms))} ms`;
}

function saveHistory() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.history));
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.history = Array.isArray(parsed) ? parsed : [];
  } catch {
    state.history = [];
  }
}

function saveSettings() {
  const payload = {
    pttKeyCode: state.pttKeyCode,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      state.pttKeyCode = DEFAULT_PTT_KEY_CODE;
      state.pttKeyLabel = hotkeyLabelFromCode(DEFAULT_PTT_KEY_CODE);
      return;
    }

    const parsed = JSON.parse(raw);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'pttKeyCode')) {
      const code = typeof parsed.pttKeyCode === 'string' ? parsed.pttKeyCode.trim() : '';
      state.pttKeyCode = code || '';
      state.pttKeyLabel = code ? hotkeyLabelFromCode(code) : '';
      return;
    }
  } catch {
    // fallback below
  }

  state.pttKeyCode = DEFAULT_PTT_KEY_CODE;
  state.pttKeyLabel = hotkeyLabelFromCode(DEFAULT_PTT_KEY_CODE);
}

function renderHotkeyUI() {
  hotkeyValueEl.textContent = state.pttKeyCode ? state.pttKeyLabel : 'Disabled';
  setHotkeyBtn.textContent = state.hotkeyCaptureArmed ? 'Press Any Key...' : 'Set Hotkey';
  updateHotkeyButtonState();
}

function renderHistory() {
  historyRowsEl.innerHTML = '';

  if (!state.history.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="5">No runs yet.</td>';
    historyRowsEl.appendChild(row);
    return;
  }

  for (const run of [...state.history].reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(run.timeIso).toLocaleTimeString()}</td>
      <td>${run.providerLabel}</td>
      <td>${formatMs(run.latencyMs)}</td>
      <td>${run.werPercent ?? 'n/a'}</td>
      <td>${(run.transcript || '').slice(0, 80).replace(/</g, '&lt;')}</td>
    `;
    historyRowsEl.appendChild(tr);
  }
}

function updateMetrics(run) {
  const pieces = [];
  pieces.push(`Provider: ${run.providerLabel}`);
  pieces.push(`Total latency: ${formatMs(run.latencyMs)}`);
  if (typeof run.firstResultMs === 'number') pieces.push(`First result: ${formatMs(run.firstResultMs)}`);
  if (run.werPercent) pieces.push(`WER: ${run.werPercent}`);
  if (run.model) pieces.push(`Model: ${run.model}`);
  metricsEl.textContent = pieces.join(' | ');
}

function finalizeRun({ provider, transcript, latencyMs, firstResultMs = null, model = '' }) {
  const ref = referenceEl.value.trim();
  const wer = ref ? wordErrorRate(ref, transcript) : null;
  const werPercent = typeof wer === 'number' ? `${(wer * 100).toFixed(1)}%` : null;

  const run = {
    timeIso: new Date().toISOString(),
    provider,
    providerLabel: parseProviderLabel(provider),
    transcript,
    latencyMs,
    firstResultMs,
    model,
    wer,
    werPercent,
  };

  state.history.push(run);
  if (state.history.length > 100) {
    state.history = state.history.slice(-100);
  }

  transcriptEl.value = transcript;
  interimEl.textContent = '';
  updateMetrics(run);
  saveHistory();
  renderHistory();
}

function getPreferredMimeType() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const mime of opts) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read audio blob.'));
    reader.onloadend = () => {
      const out = typeof reader.result === 'string' ? reader.result : '';
      const base64 = out.includes(',') ? out.split(',')[1] : out;
      resolve(base64 || '');
    };
    reader.readAsDataURL(blob);
  });
}

function stopMediaRecorder(recorder, errorMessage) {
  return new Promise((resolve, reject) => {
    if (!recorder || recorder.state === 'inactive') {
      resolve();
      return;
    }

    const onStop = () => resolve();
    const onError = () => reject(new Error(errorMessage));
    recorder.addEventListener('stop', onStop, { once: true });
    recorder.addEventListener('error', onError, { once: true });

    try {
      recorder.stop();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(errorMessage));
    }
  });
}

function maybeSetFirstResultAt(text) {
  if (state.firstResultAt != null) return;
  if (!text || !text.trim()) return;
  state.firstResultAt = nowMs();
}

function closeOpenAIRealtimeResources() {
  if (state.openaiDc) {
    try {
      state.openaiDc.onopen = null;
      state.openaiDc.onmessage = null;
      state.openaiDc.onerror = null;
      state.openaiDc.onclose = null;
      if (state.openaiDc.readyState === 'open' || state.openaiDc.readyState === 'connecting') {
        state.openaiDc.close();
      }
    } catch {
      // no-op
    }
  }

  if (state.openaiPc) {
    try {
      state.openaiPc.onconnectionstatechange = null;
      state.openaiPc.close();
    } catch {
      // no-op
    }
  }

  if (state.openaiStream) {
    for (const track of state.openaiStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // no-op
      }
    }
  }

  state.openaiDc = null;
  state.openaiPc = null;
  state.openaiStream = null;
}

function closeGroqResources() {
  if (state.groqPseudoSegmentTimer) {
    clearTimeout(state.groqPseudoSegmentTimer);
    state.groqPseudoSegmentTimer = null;
  }

  if (state.groqRecorder) {
    try {
      state.groqRecorder.ondataavailable = null;
      state.groqRecorder.onerror = null;
      state.groqRecorder.onstop = null;
      if (state.groqRecorder.state !== 'inactive') {
        state.groqRecorder.stop();
      }
    } catch {
      // no-op
    }
  }

  if (state.groqStream) {
    for (const track of state.groqStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // no-op
      }
    }
  }

  state.groqRecorder = null;
  state.groqStream = null;
  state.groqChunks = [];
  state.groqProvider = '';
  state.groqPseudoStopRequested = false;
  state.groqPseudoPendingUploads = Promise.resolve();
  state.groqPseudoLastModelUsed = '';
  state.groqPseudoHadChunkError = false;
  state.groqPseudoSessionId += 1;
}

function resetOpenAISegments() {
  state.openaiSegments = new Map();
  state.openaiCommitCounter = 0;
  state.openaiLastSegmentUpdateAt = nowMs();
}

function resetRunState() {
  closeOpenAIRealtimeResources();
  closeGroqResources();

  state.mode = 'idle';
  state.recognition = null;
  state.runStartedAt = 0;
  state.firstResultAt = null;
  state.finalText = '';
  state.openaiActiveModel = '';
  state.hotkeyPressed = false;
  state.hotkeyStartPending = false;
  resetOpenAISegments();
  setControlsRunning(false);
  renderHotkeyUI();
}

function normalizeLanguageInput(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  const match = trimmed.match(/^[a-z]{2}/);
  return match ? match[0] : '';
}

function getOrCreateOpenAISegment(itemId) {
  let segment = state.openaiSegments.get(itemId);
  if (!segment) {
    segment = {
      itemId,
      text: '',
      isFinal: false,
      previousItemId: null,
      commitSeq: null,
      updatedAt: nowMs(),
    };
    state.openaiSegments.set(itemId, segment);
  }
  return segment;
}

function markSegmentUpdated(segment) {
  segment.updatedAt = nowMs();
  state.openaiLastSegmentUpdateAt = segment.updatedAt;
}

function applyDeltaToSegment(segment, delta) {
  if (typeof delta !== 'string' || !delta) return;

  if (!segment.text) {
    segment.text = delta;
  } else if (delta.startsWith(segment.text)) {
    segment.text = delta;
  } else {
    segment.text += delta;
  }

  segment.isFinal = false;
  markSegmentUpdated(segment);
}

function compareSegmentOrder(a, b) {
  const aSeq = Number.isFinite(a.commitSeq) ? a.commitSeq : Number.MAX_SAFE_INTEGER;
  const bSeq = Number.isFinite(b.commitSeq) ? b.commitSeq : Number.MAX_SAFE_INTEGER;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.updatedAt - b.updatedAt;
}

function orderedSegmentsForRender() {
  const ordered = [...state.openaiSegments.values()].sort(compareSegmentOrder);
  if (ordered.length <= 1) return ordered;

  const guardLimit = ordered.length * 3;
  let guard = 0;
  let moved = true;

  while (moved && guard < guardLimit) {
    moved = false;
    guard += 1;

    const indexById = new Map();
    ordered.forEach((seg, idx) => {
      indexById.set(seg.itemId, idx);
    });

    for (const seg of [...ordered]) {
      if (!seg.previousItemId) continue;
      const prevIdx = indexById.get(seg.previousItemId);
      const curIdx = indexById.get(seg.itemId);
      if (prevIdx == null || curIdx == null) continue;
      if (curIdx > prevIdx) continue;

      ordered.splice(curIdx, 1);
      ordered.splice(prevIdx + 1, 0, seg);
      moved = true;
      break;
    }
  }

  return ordered;
}

function renderOpenAITranscript() {
  const ordered = orderedSegmentsForRender();
  const text = ordered
    .map((seg) => seg.text)
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  transcriptEl.value = text;
  maybeSetFirstResultAt(text);

  const hasInterim = ordered.some((seg) => !seg.isFinal && seg.text.trim());
  interimEl.textContent = hasInterim ? 'Interim: listening...' : '';
}

function handleOpenAIRealtimeEvent(eventPayload) {
  if (!eventPayload || typeof eventPayload.type !== 'string') return;

  const type = eventPayload.type;

  if (type === 'session.created' || type === 'session.updated') {
    const model = eventPayload?.session?.audio?.input?.transcription?.model;
    if (typeof model === 'string' && model.trim()) {
      state.openaiActiveModel = model.trim();
    }
    return;
  }

  if (type === 'input_audio_buffer.committed') {
    const itemId = typeof eventPayload.item_id === 'string' ? eventPayload.item_id : '';
    if (!itemId) return;

    const segment = getOrCreateOpenAISegment(itemId);
    segment.previousItemId = typeof eventPayload.previous_item_id === 'string' ? eventPayload.previous_item_id : null;
    if (!Number.isFinite(segment.commitSeq)) {
      state.openaiCommitCounter += 1;
      segment.commitSeq = state.openaiCommitCounter;
    }
    markSegmentUpdated(segment);
    renderOpenAITranscript();
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.delta') {
    const itemId = typeof eventPayload.item_id === 'string' ? eventPayload.item_id : '';
    if (!itemId) return;
    const delta = typeof eventPayload.delta === 'string' ? eventPayload.delta : '';

    const segment = getOrCreateOpenAISegment(itemId);
    applyDeltaToSegment(segment, delta);
    renderOpenAITranscript();
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = typeof eventPayload.item_id === 'string' ? eventPayload.item_id : '';
    if (!itemId) return;
    const transcript = typeof eventPayload.transcript === 'string' ? eventPayload.transcript : '';

    const segment = getOrCreateOpenAISegment(itemId);
    segment.text = transcript || segment.text;
    segment.isFinal = true;
    markSegmentUpdated(segment);
    renderOpenAITranscript();
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.failed') {
    const itemId = typeof eventPayload.item_id === 'string' ? eventPayload.item_id : 'unknown-item';
    const msg = eventPayload?.error?.message || eventPayload?.error || 'transcription failed';
    setStatus(`Realtime transcription failed for ${itemId}: ${msg}`, 'error');
    return;
  }

  if (type === 'error') {
    const msg = eventPayload?.error?.message || eventPayload?.message || 'Unknown realtime error';
    setStatus(`OpenAI realtime error: ${msg}`, 'error');
  }
}

function decodeDataChannelPayload(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return '';
}

function setupOpenAIDataChannel(dc) {
  dc.onopen = () => {
    setStatus('OpenAI realtime listening... speak now, then press Stop.');
  };

  dc.onmessage = (event) => {
    try {
      const raw = decodeDataChannelPayload(event.data);
      if (!raw) return;
      const payload = JSON.parse(raw);
      handleOpenAIRealtimeEvent(payload);
    } catch {
      // no-op
    }
  };

  dc.onerror = () => {
    setStatus('OpenAI realtime data channel error.', 'error');
  };

  dc.onclose = () => {
    if (state.mode === 'openai-realtime') {
      setStatus('OpenAI realtime channel closed.', 'error');
    }
  };
}

async function startOpenAIRealtimeCapture() {
  if (!state.hasOpenAIKey) {
    setStatus('OPENAI_API_KEY is missing in .env.', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('getUserMedia is not available in this browser.', 'error');
    return;
  }
  if (typeof RTCPeerConnection !== 'function') {
    setStatus('RTCPeerConnection is not available in this browser.', 'error');
    return;
  }

  try {
    state.mode = 'openai-connecting';
    setControlsConnecting();
    setStatus('Initializing OpenAI realtime...');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const pc = new RTCPeerConnection();
    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      if ((cs === 'failed' || cs === 'disconnected') && state.mode === 'openai-realtime') {
        setStatus(`OpenAI realtime ${cs}.`, 'error');
      }
    };

    const dc = pc.createDataChannel('oai-events');
    setupOpenAIDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const language = normalizeLanguageInput(languageEl.value);
    const setupResp = await fetch('/api/realtime/openai/sdp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: offer.sdp,
        language: language || undefined,
      }),
    });

    let setupError = '';
    let answerSdp = '';
    if (!setupResp.ok) {
      try {
        const data = await setupResp.json();
        setupError = typeof data?.error === 'string' ? data.error : '';
      } catch {
        setupError = '';
      }
      if (!setupError) setupError = `OpenAI realtime setup failed (${setupResp.status}).`;
      throw new Error(setupError);
    }

    answerSdp = await setupResp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    state.mode = 'openai-realtime';
    state.openaiPc = pc;
    state.openaiDc = dc;
    state.openaiStream = stream;
    state.openaiActiveModel = state.openaiConfiguredModel || '';
    state.runStartedAt = nowMs();
    state.firstResultAt = null;
    resetOpenAISegments();

    transcriptEl.value = '';
    interimEl.textContent = '';
    setControlsRunning(true);
    setStatus('Connecting OpenAI realtime...');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Failed to start OpenAI realtime mode.', 'error');
    resetRunState();
  }
}

async function waitForRealtimeSettle(maxWaitMs = 2200, quietMs = 420) {
  const start = nowMs();

  while (nowMs() - start < maxWaitMs) {
    const sinceUpdate = nowMs() - state.openaiLastSegmentUpdateAt;
    const hasPendingInterim = [...state.openaiSegments.values()].some((seg) => !seg.isFinal && seg.text.trim());

    if (!hasPendingInterim && sinceUpdate >= quietMs) {
      return;
    }

    await sleep(80);
  }
}

async function stopOpenAIRealtimeCapture() {
  if (state.mode !== 'openai-realtime') return;

  setStatus('Finalizing transcript...');

  if (state.openaiDc && state.openaiDc.readyState === 'open') {
    try {
      state.openaiDc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch {
      // no-op
    }
  }

  if (state.openaiStream) {
    for (const track of state.openaiStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // no-op
      }
    }
  }

  await waitForRealtimeSettle();

  const transcript = transcriptEl.value.trim();
  const endAt = nowMs();
  const firstResultMs = state.firstResultAt == null ? null : state.firstResultAt - state.runStartedAt;
  const totalMs = endAt - state.runStartedAt;

  if (transcript) {
    finalizeRun({
      provider: 'openai',
      transcript,
      latencyMs: totalMs,
      firstResultMs,
      model: state.openaiActiveModel || state.openaiConfiguredModel || '',
    });
    setStatus('OpenAI realtime transcription complete.');
  } else {
    setStatus('No speech captured.', 'error');
  }

  resetRunState();
}

function groqVariantFromProvider(provider) {
  return provider === 'groq-quality' ? 'quality' : 'turbo';
}

function groqModelForProvider(provider) {
  if (provider === 'groq-quality') {
    return state.groqConfiguredQualityModel || 'whisper-large-v3';
  }
  if (provider === 'groq-pseudo-realtime') {
    return state.groqConfiguredPseudoModel || state.groqConfiguredTurboModel || 'whisper-large-v3-turbo';
  }
  return state.groqConfiguredTurboModel || 'whisper-large-v3-turbo';
}

async function requestGroqTranscription({ blob, provider, prompt = undefined }) {
  const mime = blob.type || 'audio/webm';
  const audioBase64 = await blobToBase64(blob);
  const requestStartedAt = nowMs();
  const variant = groqVariantFromProvider(provider);
  const model = groqModelForProvider(provider);
  const language = normalizeLanguageInput(languageEl.value);

  const resp = await fetch('/api/transcribe/groq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64,
      mimeType: mime,
      variant,
      model,
      language: language || undefined,
      prompt,
    }),
  });

  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(data?.error || 'Groq transcription request failed.');
  }

  return {
    transcript: typeof data?.transcript === 'string' ? data.transcript.trim() : '',
    modelUsed: typeof data?.modelUsed === 'string' ? data.modelUsed : model,
    latencyMs: typeof data?.latencyMs === 'number' ? data.latencyMs : nowMs() - requestStartedAt,
  };
}

function mergeTranscriptChunk(existing, nextChunk) {
  const existingText = (existing || '').trim();
  const chunkText = (nextChunk || '').trim();
  if (!chunkText) return existingText;
  if (!existingText) return chunkText;

  const existingLower = existingText.toLowerCase();
  const chunkLower = chunkText.toLowerCase();
  const maxOverlap = Math.min(existingLower.length, chunkLower.length, 90);
  let overlap = 0;

  for (let size = maxOverlap; size >= 6; size -= 1) {
    if (existingLower.slice(-size) === chunkLower.slice(0, size)) {
      overlap = size;
      break;
    }
  }

  return `${existingText} ${chunkText.slice(overlap)}`.replace(/\s+/g, ' ').trim();
}

function buildGroqPseudoPrompt() {
  const tail = transcriptEl.value.trim().slice(-280);
  if (!tail) return undefined;
  return `Continue this transcript naturally without repeating prior words. Prior context: ${tail}`;
}

function clearGroqPseudoTimer() {
  if (state.groqPseudoSegmentTimer) {
    clearTimeout(state.groqPseudoSegmentTimer);
    state.groqPseudoSegmentTimer = null;
  }
}

async function waitForGroqPseudoUploadsToFlush() {
  let observed = state.groqPseudoPendingUploads;
  while (observed) {
    try {
      await observed;
    } catch {
      // no-op
    }
    if (observed === state.groqPseudoPendingUploads) break;
    observed = state.groqPseudoPendingUploads;
  }
}

function queueGroqPseudoChunkUpload(blob, sessionId) {
  state.groqPseudoPendingUploads = state.groqPseudoPendingUploads.then(async () => {
    if (sessionId !== state.groqPseudoSessionId) return;

    try {
      const { transcript, modelUsed } = await requestGroqTranscription({
        blob,
        provider: 'groq-pseudo-realtime',
        prompt: buildGroqPseudoPrompt(),
      });
      if (sessionId !== state.groqPseudoSessionId) return;

      if (transcript) {
        const merged = mergeTranscriptChunk(transcriptEl.value, transcript);
        transcriptEl.value = merged;
        maybeSetFirstResultAt(merged);
        state.groqPseudoLastModelUsed = modelUsed;
      }
    } catch (err) {
      if (!state.groqPseudoHadChunkError) {
        setStatus(err instanceof Error ? err.message : 'Groq pseudo-realtime chunk failed.', 'error');
      }
      state.groqPseudoHadChunkError = true;
    }
  });
}

function startNextGroqPseudoSegment(sessionId) {
  if (state.mode !== 'groq-pseudo-realtime') return;
  if (!state.groqStream) return;
  if (state.groqPseudoStopRequested) return;
  if (sessionId !== state.groqPseudoSessionId) return;

  const mimeType = getPreferredMimeType();
  const recorder = mimeType ? new MediaRecorder(state.groqStream, { mimeType }) : new MediaRecorder(state.groqStream);
  const segmentChunks = [];
  state.groqRecorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      segmentChunks.push(event.data);
    }
  };

  recorder.onerror = () => {
    state.groqPseudoHadChunkError = true;
    setStatus('Groq pseudo-realtime recorder error.', 'error');
  };

  recorder.onstop = () => {
    if (sessionId !== state.groqPseudoSessionId) return;
    clearGroqPseudoTimer();

    const mime = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(segmentChunks, { type: mime });
    if (blob.size > 0) {
      queueGroqPseudoChunkUpload(blob, sessionId);
    }

    if (state.mode === 'groq-pseudo-realtime' && !state.groqPseudoStopRequested) {
      startNextGroqPseudoSegment(sessionId);
    }
  };

  recorder.start(180);
  clearGroqPseudoTimer();
  state.groqPseudoSegmentTimer = setTimeout(() => {
    if (sessionId !== state.groqPseudoSessionId) return;
    if (recorder.state !== 'recording') return;
    try {
      recorder.stop();
    } catch {
      // no-op
    }
  }, GROQ_PSEUDO_REALTIME_CHUNK_MS);
}

async function startGroqCapture(provider) {
  if (!state.hasGroqKey) {
    setStatus('GROQ_API_KEY is missing in .env.', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('getUserMedia is not available in this browser.', 'error');
    return;
  }
  if (!window.MediaRecorder) {
    setStatus('MediaRecorder is not available in this browser.', 'error');
    return;
  }

  try {
    state.mode = 'groq-connecting';
    setControlsConnecting();
    setStatus('Initializing Groq recorder...');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const mimeType = getPreferredMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    state.groqProvider = provider;
    state.groqStream = stream;
    state.groqRecorder = recorder;
    state.groqChunks = [];

    state.runStartedAt = nowMs();
    state.firstResultAt = null;
    transcriptEl.value = '';
    interimEl.textContent = '';

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        state.groqChunks.push(event.data);
      }
    };

    recorder.start(250);
    state.mode = 'groq-recording';
    setControlsRunning(true);
    setStatus(`${parseProviderLabel(provider)} recording... press Stop to transcribe.`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Failed to start Groq recording.', 'error');
    resetRunState();
  }
}

async function stopGroqCapture(provider) {
  if (state.mode !== 'groq-recording') return;
  const recorder = state.groqRecorder;
  if (!recorder) return;

  try {
    setStatus('Uploading audio to Groq...');
    await stopMediaRecorder(recorder, 'Groq recorder failed while stopping.');

    const mime = recorder.mimeType || 'audio/webm';
    const blob = new Blob(state.groqChunks, { type: mime });
    if (!blob.size) {
      throw new Error('No recorded audio data found.');
    }

    const { transcript, modelUsed, latencyMs } = await requestGroqTranscription({ blob, provider });

    if (transcript) {
      finalizeRun({
        provider,
        transcript,
        latencyMs,
        firstResultMs: null,
        model: modelUsed,
      });
      setStatus(`${parseProviderLabel(provider)} transcription complete.`);
    } else {
      setStatus('No speech captured.', 'error');
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Groq transcription failed.', 'error');
  } finally {
    resetRunState();
  }
}

async function startGroqPseudoRealtimeCapture() {
  if (!state.hasGroqKey) {
    setStatus('GROQ_API_KEY is missing in .env.', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('getUserMedia is not available in this browser.', 'error');
    return;
  }
  if (!window.MediaRecorder) {
    setStatus('MediaRecorder is not available in this browser.', 'error');
    return;
  }

  try {
    state.mode = 'groq-connecting';
    setControlsConnecting();
    setStatus('Initializing Groq pseudo-realtime recorder...');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    state.groqStream = stream;
    state.groqProvider = 'groq-pseudo-realtime';
    state.groqRecorder = null;
    state.groqChunks = [];
    state.groqPseudoStopRequested = false;
    state.groqPseudoPendingUploads = Promise.resolve();
    state.groqPseudoLastModelUsed = '';
    state.groqPseudoHadChunkError = false;
    state.groqPseudoSessionId += 1;

    state.runStartedAt = nowMs();
    state.firstResultAt = null;
    transcriptEl.value = '';
    interimEl.textContent = 'Interim: transcribing chunked audio...';

    state.mode = 'groq-pseudo-realtime';
    setControlsRunning(true);
    setStatus('Groq pseudo-realtime listening... updates every ~1 second.');

    startNextGroqPseudoSegment(state.groqPseudoSessionId);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Failed to start Groq pseudo-realtime mode.', 'error');
    resetRunState();
  }
}

async function stopGroqPseudoRealtimeCapture() {
  if (state.mode !== 'groq-pseudo-realtime') return;

  setStatus('Finalizing pseudo-realtime transcript...');
  state.groqPseudoStopRequested = true;
  clearGroqPseudoTimer();

  const recorder = state.groqRecorder;
  if (recorder && recorder.state !== 'inactive') {
    try {
      await stopMediaRecorder(recorder, 'Groq pseudo-realtime recorder failed while stopping.');
    } catch {
      // no-op
    }
  }

  await waitForGroqPseudoUploadsToFlush();

  const transcript = transcriptEl.value.trim();
  const endAt = nowMs();
  const firstResultMs = state.firstResultAt == null ? null : state.firstResultAt - state.runStartedAt;
  const totalMs = endAt - state.runStartedAt;

  if (transcript) {
    finalizeRun({
      provider: 'groq-pseudo-realtime',
      transcript,
      latencyMs: totalMs,
      firstResultMs,
      model: state.groqPseudoLastModelUsed || groqModelForProvider('groq-pseudo-realtime'),
    });
    if (state.groqPseudoHadChunkError) {
      setStatus('Groq pseudo-realtime complete with some chunk errors.', 'error');
    } else {
      setStatus('Groq pseudo-realtime transcription complete.');
    }
  } else {
    setStatus('No speech captured.', 'error');
  }

  resetRunState();
}

function startWebSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus('Web Speech API is not available in this browser. Try Chrome.', 'error');
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  const langRaw = languageEl.value.trim();
  if (langRaw) recognition.lang = langRaw;

  state.mode = 'web-speech';
  state.runStartedAt = nowMs();
  state.firstResultAt = null;
  state.finalText = '';
  state.recognition = recognition;

  recognition.onstart = () => {
    setControlsRunning(true);
    setStatus('Web Speech listening...');
  };

  recognition.onresult = (event) => {
    if (state.firstResultAt == null) state.firstResultAt = nowMs();

    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript || '';
      if (result.isFinal) {
        state.finalText = `${state.finalText} ${text}`.trim();
      } else {
        interim += text;
      }
    }

    transcriptEl.value = `${state.finalText}${interim ? ` ${interim}` : ''}`.trim();
    interimEl.textContent = interim ? `Interim: ${interim}` : '';
  };

  recognition.onerror = (event) => {
    setStatus(`Web Speech error: ${event.error}`, 'error');
    try {
      recognition.stop();
    } catch {
      // no-op
    }
  };

  recognition.onend = () => {
    const transcript = (state.finalText || transcriptEl.value || '').trim();
    const endAt = nowMs();
    const firstResultMs = state.firstResultAt == null ? null : state.firstResultAt - state.runStartedAt;
    const totalMs = endAt - state.runStartedAt;

    if (transcript) {
      finalizeRun({
        provider: 'web-speech',
        transcript,
        latencyMs: totalMs,
        firstResultMs,
      });
      setStatus('Web Speech transcription complete.');
    } else {
      setStatus('No speech captured.', 'error');
    }

    resetRunState();
  };

  recognition.start();
}

async function startSelectedProvider() {
  if (state.mode !== 'idle') return;

  const provider = providerEl.value;
  if (provider === 'web-speech') {
    startWebSpeech();
    return;
  }

  if (provider === 'openai') {
    await startOpenAIRealtimeCapture();
    return;
  }

  if (isGroqPseudoRealtimeProvider(provider)) {
    await startGroqPseudoRealtimeCapture();
    return;
  }

  if (isGroqBatchProvider(provider)) {
    await startGroqCapture(provider);
  }
}

async function stopSelectedProvider() {
  const provider = providerEl.value;
  if (provider === 'web-speech' && state.recognition) {
    state.recognition.stop();
    return;
  }

  if (provider === 'openai') {
    await stopOpenAIRealtimeCapture();
    return;
  }

  if (isGroqPseudoRealtimeProvider(provider)) {
    await stopGroqPseudoRealtimeCapture();
    return;
  }

  if (isGroqBatchProvider(provider)) {
    await stopGroqCapture(provider);
  }
}

startBtn.addEventListener('click', async () => {
  await startSelectedProvider();
});

stopBtn.addEventListener('click', async () => {
  await stopSelectedProvider();
});

clearBtn.addEventListener('click', () => {
  transcriptEl.value = '';
  interimEl.textContent = '';
  metricsEl.textContent = 'Last run: n/a';
});

clearHistoryBtn.addEventListener('click', () => {
  state.history = [];
  saveHistory();
  renderHistory();
});

exportBtn.addEventListener('click', () => {
  const payload = JSON.stringify(state.history, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stt-history-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function cancelHotkeyCapture(showStatus = true) {
  state.hotkeyCaptureArmed = false;
  renderHotkeyUI();
  if (showStatus) {
    setStatus('Hotkey capture canceled.');
  }
}

setHotkeyBtn.addEventListener('click', () => {
  if (state.mode !== 'idle') return;

  state.hotkeyCaptureArmed = !state.hotkeyCaptureArmed;
  renderHotkeyUI();

  if (state.hotkeyCaptureArmed) {
    setStatus('Press a key to set push-to-talk. Press Escape to cancel.');
  } else {
    setStatus('Hotkey capture canceled.');
  }
});

clearHotkeyBtn.addEventListener('click', () => {
  if (state.mode !== 'idle') return;
  state.hotkeyCaptureArmed = false;
  state.pttKeyCode = '';
  state.pttKeyLabel = '';
  state.hotkeyPressed = false;
  state.hotkeyStartPending = false;
  saveSettings();
  renderHotkeyUI();
  setStatus('Push-to-talk hotkey disabled.');
});

window.addEventListener('keydown', (event) => {
  if (state.hotkeyCaptureArmed) {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.code === 'Escape') {
      cancelHotkeyCapture(true);
      return;
    }
    const code = typeof event.code === 'string' ? event.code.trim() : '';
    if (!code || code === 'Unidentified') return;
    state.pttKeyCode = code;
    state.pttKeyLabel = hotkeyLabelFromCode(code);
    state.hotkeyCaptureArmed = false;
    saveSettings();
    renderHotkeyUI();
    setStatus(`Push-to-talk hotkey set to ${state.pttKeyLabel}. Hold to listen, release to stop.`);
    return;
  }

  if (!state.pttKeyCode || event.code !== state.pttKeyCode) return;

  event.preventDefault();
  if (event.repeat || state.hotkeyPressed) return;

  state.hotkeyPressed = true;
  state.hotkeyStartPending = true;

  void (async () => {
    await startSelectedProvider();
    state.hotkeyStartPending = false;
    if (!state.hotkeyPressed) {
      await stopSelectedProvider();
    }
  })();
});

window.addEventListener('keyup', (event) => {
  if (!state.pttKeyCode || event.code !== state.pttKeyCode) return;

  event.preventDefault();
  if (!state.hotkeyPressed && !state.hotkeyStartPending) return;

  state.hotkeyPressed = false;
  if (state.hotkeyStartPending) return;
  void stopSelectedProvider();
});

window.addEventListener('blur', () => {
  if (!state.hotkeyPressed && !state.hotkeyStartPending) return;
  state.hotkeyPressed = false;
  if (!state.hotkeyStartPending) {
    void stopSelectedProvider();
  }
});

(async function bootstrap() {
  loadHistory();
  loadSettings();
  renderHistory();
  renderHotkeyUI();

  try {
    const resp = await fetch('/api/health');
    const data = await resp.json();

    state.hasOpenAIKey = Boolean(data?.hasOpenAIKey);
    state.hasGroqKey = Boolean(data?.hasGroqKey);

    state.openaiConfiguredModel = typeof data?.openaiModel === 'string' ? data.openaiModel : '';
    state.groqConfiguredTurboModel = typeof data?.groqTurboModel === 'string' ? data.groqTurboModel : 'whisper-large-v3-turbo';
    state.groqConfiguredQualityModel = typeof data?.groqQualityModel === 'string' ? data.groqQualityModel : 'whisper-large-v3';
    state.groqConfiguredPseudoModel =
      typeof data?.groqPseudoRealtimeModel === 'string'
        ? data.groqPseudoRealtimeModel
        : state.groqConfiguredTurboModel || 'whisper-large-v3-turbo';

    if (!state.hasOpenAIKey && !state.hasGroqKey) {
      setStatus('OPENAI_API_KEY and GROQ_API_KEY are both missing. Web Speech mode still works.', 'error');
      return;
    }

    const available = [];
    if (state.hasOpenAIKey) {
      const modelText = state.openaiConfiguredModel ? ` (${state.openaiConfiguredModel})` : '';
      available.push(`OpenAI realtime${modelText}`);
    }
    if (state.hasGroqKey) {
      available.push(`Groq turbo (${state.groqConfiguredTurboModel})`);
      available.push(`Groq quality (${state.groqConfiguredQualityModel})`);
      available.push(`Groq pseudo-realtime (${state.groqConfiguredPseudoModel})`);
    }

    setStatus(`Ready. Choose provider and press Start Listening. Available: ${available.join(' | ')}`);
  } catch {
    setStatus('Server health check failed.', 'error');
  }
})();
