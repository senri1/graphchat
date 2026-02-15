import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

const app = express();
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '40mb' }));
app.use(express.static(path.join(rootDir, 'public')));

function defaultRealtimeModel() {
  return process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
}

function defaultGroqTurboModel() {
  return process.env.GROQ_TRANSCRIBE_MODEL_TURBO || 'whisper-large-v3-turbo';
}

function defaultGroqQualityModel() {
  return process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3';
}

function defaultGroqPseudoRealtimeModel() {
  return process.env.GROQ_TRANSCRIBE_MODEL_PSEUDO_REALTIME || defaultGroqTurboModel();
}

function normalizeLanguageCode(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;

  const match = trimmed.match(/^[a-z]{2}/);
  return match ? match[0] : undefined;
}

function parseIncomingAudio(body) {
  const audioBase64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : '';
  if (!audioBase64) {
    throw new Error('Missing audioBase64 in request body.');
  }

  const mimeType = typeof body?.mimeType === 'string' && body.mimeType.trim() ? body.mimeType.trim() : 'audio/webm';
  const normalized = audioBase64.includes(',') ? audioBase64.split(',').pop() : audioBase64;
  const audioBuffer = Buffer.from(normalized || '', 'base64');
  if (!audioBuffer.byteLength) {
    throw new Error('Decoded audio is empty.');
  }
  return { audioBuffer, mimeType };
}

function pickExtensionFromMimeType(mimeType) {
  if (!mimeType) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  return 'webm';
}

async function transcribeWithGroq({ apiKey, audioBuffer, mimeType, model, language, prompt }) {
  const form = new FormData();
  const ext = pickExtensionFromMimeType(mimeType);
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Groq transcription failed (${resp.status}): ${txt.slice(0, 600)}`);
  }

  const data = await resp.json();
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  return { text, raw: data };
}

function buildTranscriptionSessionConfig({ model, language }) {
  const transcription = { model };
  if (language) transcription.language = language;

  return {
    type: 'transcription',
    audio: {
      input: {
        transcription,
        noise_reduction: { type: 'near_field' },
        // Lower silence duration so turns commit sooner for faster visible text updates.
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 220,
        },
      },
    },
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    openaiModel: defaultRealtimeModel(),
    groqTurboModel: defaultGroqTurboModel(),
    groqQualityModel: defaultGroqQualityModel(),
    groqPseudoRealtimeModel: defaultGroqPseudoRealtimeModel(),
    transport: 'webrtc-realtime-calls',
  });
});

app.post('/api/realtime/openai/sdp', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'OPENAI_API_KEY is missing in .env' });
    }

    const sdp = typeof req.body?.sdp === 'string' ? req.body.sdp : '';
    if (!sdp.trim()) {
      return res.status(400).json({ error: 'Missing SDP offer in request body.' });
    }

    const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null;
    const model = requestedModel || defaultRealtimeModel();
    const language = normalizeLanguageCode(req.body?.language);

    const session = buildTranscriptionSessionConfig({ model, language });
    const form = new FormData();
    form.set('sdp', sdp);
    form.set('session', JSON.stringify(session));

    const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    const bodyText = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `OpenAI realtime SDP exchange failed (${upstream.status}): ${bodyText.slice(0, 600)}`,
      });
    }

    res.type('application/sdp').send(bodyText);
    return undefined;
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown realtime setup error',
    });
  }
});

app.post('/api/transcribe/groq', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'GROQ_API_KEY is missing in .env' });
    }

    const { audioBuffer, mimeType } = parseIncomingAudio(req.body);

    const fallbackModel =
      req.body?.variant === 'quality'
        ? defaultGroqQualityModel()
        : req.body?.variant === 'turbo'
          ? defaultGroqTurboModel()
          : defaultGroqTurboModel();
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : fallbackModel;
    const language = normalizeLanguageCode(req.body?.language);
    const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim() ? req.body.prompt.trim() : undefined;

    const t0 = performance.now();
    const { text } = await transcribeWithGroq({
      apiKey,
      audioBuffer,
      mimeType,
      model,
      language,
      prompt,
    });
    const latencyMs = Math.round(performance.now() - t0);

    return res.json({
      provider: 'groq',
      transcript: text,
      modelUsed: model,
      latencyMs,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown Groq transcription error',
    });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`stt-playground listening on http://${host}:${port}`);
});
