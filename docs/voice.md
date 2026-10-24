# Phone dictation: PC first, Google as backup

On Android, the microphone uses the PC's installed Parakeet model when the desktop app is connected. A small **PC** label appears while recording. Transcribed text stays in the composer for editing; sending remains manual, including agent-session composers.

## Use it

1. Open the desktop app with the Parakeet voice model installed.
2. Connect the phone to that app's daemon and tap the composer microphone.
3. Speak for up to 60 seconds, stop, review the text, and send it yourself.

Without PC capability, the phone opens its existing native dictation dialog. If PC recording, transfer, or recognition fails or times out, that dialog opens automatically; **speak again in the phone dialog**. Google does not receive the previously captured WAV.

## Boundaries

| Hop | Contract |
| --- | --- |
| Phone capture | Web Audio ScriptProcessor fallback, mono downsampled to 16 kHz, signed 16-bit canonical PCM WAV; microphone tracks and AudioContext close on stop/cancel. |
| Phone → daemon | `voice_transcribe`, at most 2,560,060 base64 characters (1,920,044 WAV bytes); WebSocket payload ceiling 3 MiB. |
| Daemon → app | Existing private channel, unchanged 1 MiB frame ceiling; `voice_begin`, ordered `voice_chunk` (≤256,000 base64 characters), `voice_finish`, best-effort `voice_cancel`. |
| App assembly | One upload at a time, opaque transfer id, ≤1,920,044 bytes, expires after 90 seconds or on disconnect/cancel; finish consumes it once. |
| Recognition | Strict WAV header/rate/channels/length validation, shared Parakeet load cache and idle unload, no audio file or external API. |
| Deadline | Daemon transaction 75 seconds; UI reply wait 85 seconds. Native decoding already running cannot be interrupted, but its late response is ignored after cancellation. |

The daemon reports local capability only after a connected desktop confirms the model is installed. OpenAI remains available for existing browser/computer voice clients and speech output; Android PC failures use native phone dictation, not an automatic upload of the WAV to Google.

## Device verification still required

- Android WebView grants Web Audio microphone access and releases it after cancellation.
- Cold model loading and a full-minute recording finish within the deadlines on the target PC.
- Changing the active agent session while recording drops that session's capture and ignores late results.
