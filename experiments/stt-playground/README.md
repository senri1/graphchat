# STT Playground

Push-to-talk harness for comparing live speech-to-text approaches before integrating into the main app.

## Included modes

1. Browser Web Speech API (local/browser-native live interim text)
2. OpenAI Realtime over WebRTC (lowest-latency cloud path)
3. Groq Pseudo-Realtime (`whisper-large-v3-turbo`, chunked uploads with frequent partial updates)
4. Groq Whisper Turbo (`whisper-large-v3-turbo`, record then transcribe)
5. Groq Whisper Quality (`whisper-large-v3`, record then transcribe)

## Setup

1. `cd /Users/sen/Code/graphchatv1/experiments/stt-playground`
2. Open `.env` and paste your keys.
3. `npm install`
4. `npm run dev`
5. Open `http://localhost:4310`

## Keys and models

Edit `.env`:

- `OPENAI_API_KEY` for OpenAI Realtime provider
- `GROQ_API_KEY` for Groq providers
- Optional: `OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
- Optional: `GROQ_TRANSCRIBE_MODEL_TURBO=whisper-large-v3-turbo`
- Optional: `GROQ_TRANSCRIBE_MODEL=whisper-large-v3`
- Optional: `GROQ_TRANSCRIBE_MODEL_PSEUDO_REALTIME=whisper-large-v3-turbo`

## Architecture

1. OpenAI Realtime mode:
- Browser captures mic audio and opens WebRTC.
- Server exchanges SDP with OpenAI via `POST /v1/realtime/calls`.
- Data channel events stream transcript deltas into the textarea while speaking.

2. Groq modes:
- Browser records audio until you press Stop.
- Audio is sent to Groq `/openai/v1/audio/transcriptions`.
- Transcript is returned as a final result (no streaming deltas).

3. Groq pseudo-realtime mode:
- Browser records short chunks (about 1 second each).
- Each chunk is transcribed immediately and appended in the transcript box.
- This is not websocket streaming; it is rapid chunk polling for near-live updates.

## Notes

- Browser Web Speech requires a compatible browser (typically Chromium-based).
- History and WER estimates are local-only (stored in browser localStorage).
- Push-to-talk hotkey is configurable in the UI: press key down to start listening, release to stop.
