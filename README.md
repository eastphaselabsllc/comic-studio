# Comic Studio v1.1

A standalone, mobile-first comic creator. Built in `/workspace/comic-studio`; no changes to Twin, Creator Lab, faceapi, PCs, GitHub, or deployment services.

**Scope:** fictional adults (18+) only. Explicit adult content and nudity between consenting fictional adults is allowed. Minors, age ambiguity, childlike framing, real identifiable people, bestiality, and non-consent are blocked. Venice image requests use `safe_mode: false`. Uncensored models are listed first (`chroma`, then `lustify-sdxl` for images; `default_vision`, `most_uncensored`, and `venice-uncensored-1-2` are always offered for text).

## Run on the box

```sh
cd /workspace/comic-studio
python3 -m http.server 4173 --bind 127.0.0.1
# Open http://127.0.0.1:4173 on the box.
```

No build step, dependencies, or API keys required. `file://` does not support modules, service workers, or normal installability; use the server.

The app starts in **Offline demo mode**. “Try a sample story” creates two fictional adults and a non-graphic science-fiction romance script. Polish, planning, panel art, and reference generation all use local mocks in this mode. Nothing contacts Venice or a PC until the user changes settings and invokes an action.

## What is included

- Dark, touch-friendly single-page interface with safe-area padding and 48px controls.
- Installable manifest, PNG icons, Apple home-screen metadata, and offline service worker. Same-directory/subpath deployment works.
- Characters: appearance description, adult age and fictional-attestation checks, personality, backstory, body/hair/outfit/tattoo presets, image upload, turnaround-sheet upload and generation.
- Series > episodes, per-series art style, editable scripts and selected cast, AI polish preview/apply/undo.
- AI-planned pages and editable panel cards: page layout, camera angle, scene prompt, cast, dialogue, captions, lettering position, add/remove panels and pages, regenerate a single panel.
- **Generate comic** splits the script into a configurable number of panels (45 by default, up to 72) and illustrates them in order through the existing image pipeline, reusing saved character references. Progress shows `12/45`. Cancel keeps finished panels; Resume retries only the ones without art. New panels are not given speech bubbles, captions, or dialogue lettering.
- Speech bubbles are added only by hand. Pick a preset, drag it onto the panel, and type. They stay overlays on top of the art in the reader and in a page download. Image requests also tell the model not to draw balloons or words, and quoted speech is removed from the scene text sent to the image model.
- Page reader with previous/next, horizontal swipe, and keyboard navigation.
- IndexedDB image blobs and library metadata, debounced autosaving, JSON backup/export and validated atomic restore. Backups contain all referenced art, not connection settings or keys.
- Raster-image validation/resize, text escaping, no external scripts or analytics, CSP, no network API caching.
- No automatic generations or silent spending. Even live fallback requires confirmation.

## API wiring

### Venice

- Key set by the owner in Settings, stored under `localStorage.cs_k` on this origin. No real key was sought or used during development.
- Base: `https://api.venice.ai/api/v1`; authenticated requests use `Authorization: Bearer <key>`.
- “Load available models”: `GET /models?type=all`, excludes `model_spec.deprecation`, text and image models only. Uncensored models (`model_spec.uncensored: true`) are sorted first, with stable order otherwise. Image models pin `chroma`, then `lustify-sdxl`, then other uncensored models, then the rest. The text picker always offers `default_vision`, `most_uncensored`, and `venice-uncensored-1-2` at the top. Discovery is explicit, not startup/background activity.
- Text: `POST /chat/completions`, streaming SSE. Default `most_uncensored` trait (currently `venice-uncensored-1-2`). `default_vision` is still offered, but thinking is turned off so a long reply is not silent. Selected character profiles + current script are context; provider system safety stays enabled. Text is checked before and after the API call. A dropped connection says what happened and offers Try again.
- Images: `POST /image/generate`, default `chroma`, PNG/base64 response, `cfg_scale: 7`, 28 steps, 832×1216, **`safe_mode: false`**.
- If Chroma returns HTTP 404 (missing model), offers one separately confirmed request using `lustify-sdxl`. It does not auto-retry a timeout, network failure, policy error, or uncertain generation.
- Reference support is capability-based: only send `style_references` if the selected model advertises `model_spec.supportsStyleReferences`; respect its advertised count. Load models in Settings to discover this. Chroma and Lustify do not accept them. On models that do, a style reference is aesthetic guidance, not face lock. Every panel prompt starts with a fixed visual identity block (face, hair, body, outfit, tattoos) and reuses a stable seed for that cast. The scene is shortened to the model’s prompt limit before any identity text is cut.
- No undocumented `face_b64` field is sent to Venice.
- Every live text/image generation asks before making a potentially paid request; declining prevents it.

### Optional local image server

- The configured endpoint is always preferred for images. Text continues to use Venice (or demo mocks).
- `POST {localURL}/image/generate`: `{prompt, width, height, steps, cfg_scale, negative_prompt, face_b64?}`.
- `face_b64` is the first selected character’s saved raster reference, raw base64. This matches `/workspace/faceapi/server_current.py` and the existing Twin request pattern. Response: `{images: ["<raw base64 png>"]}`; raster data URIs also accepted.
- Local token is separate (`cs_local_k`); **Venice’s key is never leaked to a custom host**. Server may require its own bearer token.
- A 660-second client deadline accommodates the server’s up-to-600-second render loop; one render at a time in this app. A timed-out render may still be running remotely.
- Failure does not silently spend credits. Cloud fallback is disabled by default; when enabled, local failure still asks permission and then confirms the Venice request.
- URL must be HTTPS (or localhost for box development), without embedded credentials, query, or fragment. For phones use a reachable, authenticated HTTPS tunnel and appropriate CORS. `127.0.0.1` on a phone is the phone, not the PC.

## Privacy and safety limitations

- “Private” means data stays in this device/browser until explicitly sent to an AI provider or exported. **No login, lock screen, encryption, user authentication, or cloud sync.** Public static hosting exposes source code, not the phone’s IndexedDB, but someone sharing the browser profile can read its data. Use a trusted hosting origin.
- API keys are in localStorage, visible to code served by that origin; they are not encrypted or included in backups. A hardened deployment should use authenticated server-side proxying and quotas.
- Client checks enforce adult ages, fictional-character attestation, minor/school-age/age-ambiguous terms, non-consent, and animal-sex terms. Explicit adult content and nudity between consenting fictional adults is allowed. Inputs, generated text, plans, and imported metadata are checked. **These are heuristic client-side guardrails, not tamper-proof moderation or visual age verification.** Uploaded/generated raster art is not automatically content-classified. A production backend needs independent moderation and policy enforcement.
- Local reference conditioning supports **one face only**. Multi-character consistency and exact tattoo placement are not solved. Turnaround sheets may be weaker FaceID inputs than a clean front portrait.
- Service worker caches only the app shell, never API requests, credentials, backups, or image blobs. Browser website-data eviction still removes the library; export regularly. Persistent-storage requests may be denied, including on mobile Safari.
- v1 caps: 100 characters, 100 series, 200 episodes/series, 12 pages/episode, 6 panels/page, 72 panels/episode. The quick **Plan pages** action still asks for at most 36 panels. **Generate comic** uses the Settings panel count, default 45. Upload up to 20 MB; raster refs resized to 1536px; backup import limited to 100 MB. Very large libraries need chunked/ZIP backup in a future version.
- No sync/multiplayer, panel reorder/drag-resize, PDF/CBZ export, advanced lettering placement, or guaranteed character continuity. No actual iPhone/Safari hardware validation yet.
- User style-reference attachment path in the brief was not present on this executor’s box; no personal style images were embedded. The default style uses the written description.

## Put it on a phone (not done)

1. Review the adult-content scope and production limitations above.
2. Host **only** the runtime files listed below on an HTTPS static host: a separate GitHub Pages repo like Twin, Cloudflare Pages, Netlify, or your own HTTPS server. No deployment, repository, push, or domain change was made.
3. For local image generation, configure your PC server’s authenticated HTTPS tunnel and CORS for that exact hosting origin. PC/GPU must be awake. Do not expose the unauthenticated ComfyUI admin port.
4. Open the hosted app in iPhone Safari > Share > Add to Home Screen. Existing Twin credentials/data do not migrate automatically; enter keys privately in this app’s Settings when ready.
5. Keep demo mode on until ready; then configure endpoints, save, explicitly load models, and approve each live operation. No paid end-to-end testing has been performed.
6. Export backup before changing origin/domain; browser data is origin-specific and is not shared with the box preview.

**Runtime files:** `index.html`, `styles.css`, `app.js`, `core.js`, `db.js`, `provider.js`, `batch.js`, `bubbles.js`, `bubbles/*.svg`, `manifest.json`, `sw.js`, `icon.svg`, `icon-192.png`, `icon-512.png`.

## Speech bubbles

Open a panel that already has art and tap **Speech bubbles** (or **Bubbles** in the reader). Nothing is placed for you. Pick a preset, then:

- Drag the bubble, or the ✥ handle, to place it. Drag the corner to resize. Drag the teal dot to aim the tail.
- Tap the words to type. Font size is the slider. **Flip tail** mirrors the art and the tail. **Delete** removes the selected bubble.
- **Done** saves the bubbles on that panel. They stay on top of the art in the storyboard, the reader, and **↓ Page**.

To add your own bubble art later, drop a PNG or SVG into `bubbles/` and append one entry to `BUBBLE_PRESETS` in `bubbles.js` (`id`, `name`, `src`, `tail` of `point`, `circles`, or `none`). The app draws the tail, so the file only needs to be the body. New files under `bubbles/` are cached by the service worker after they are requested; built-ins are precached. Bump `CACHE` in `sw.js` when you ship the change so installed phones pick it up.

Do not deploy the tests, generated test backup, or this README if you only want the application public. Increment the service-worker cache version whenever deploying updates.

## Tests

```sh
npm test
# Node unit tests, no packages or network access needed.

# With local server already running and Playwright/Chrome available:
/workspace/clvenv/bin/python tests/browser_smoke.py
```

Browser smoke test intercepts all external requests. It covers the 390×844 mobile interface, no horizontal overflow, demo polish/apply/undo, page planning, individual panel generation, editable lettering, reader buttons/keyboard/swipe, reference upload/generation, backup export/import, persisted images after reload, mock live model discovery/text/image, separate local auth, first-face payload, cloud fallback + style references, cancellation/safety, and offline reload through the real service worker. It never talks to Venice or the PC.

Artifacts: `tests/browser-report.json`, `tests/home-mobile.png`, `tests/storyboard-mobile.png`, generated `tests/roundtrip-backup.json` (fictional sample only).

## Changelog

### v1.4

- Generated panels no longer get automatic speech bubbles or caption overlays from script dialogue. Bubbles appear only after a preset is placed and the text is typed. Service worker cache is `comic-studio-v1.4.0`.

### v1.3

- AI polish and page planning stream from Venice and disable hidden reasoning, so iPhone Safari is not left waiting on a silent response. The default text model is `most_uncensored`. Failures explain what happened and offer Try again. Form errors show inside the open modal.
- Panel prompts lead with each character’s visual identity, keep that text when the scene is shortened, and reuse a seed for the same cast. Generate comic stays in script order and assigns the characters named in each beat. Service worker cache is `comic-studio-v1.3.0`.

### v1.2

- Generate a full comic from the script. Panel count is a setting, default 45. Images run one at a time with progress, cancel, and resume that skips finished panels. IndexedDB upgrades from v1 to v2 without clearing stories; panels gain a `bubbles` array.
- Speech-bubble editor with five built-in SVG presets and a single `BUBBLE_PRESETS` list for adding more.
- Service worker cache is `comic-studio-v1.2.0`.

### v1.1

- Venice image requests now send `safe_mode: false`.
- Model pickers pin `default_vision`, `most_uncensored`, and `venice-uncensored-1-2` for text, and `chroma` then `lustify-sdxl` for images. Models with `model_spec.uncensored: true` are listed first (and labeled `id · uncensored`); deprecated models are still excluded.
- POLICY and client filters allow explicit adult content and nudity between consenting fictional adults (18+). Minors, under-18 ages, age ambiguity, bestiality, real identifiable people, and non-consent remain blocked. Every character must still be `fictional: true` with age 18–150.
