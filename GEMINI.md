# Project Notes for Agents (Gemini)

## Stack & Policy
- React 19 + Vite, JavaScript only (JS/JSX). No TypeScript.
- ESM imports with explicit `.js`/`.jsx` extensions.

## Layout
- `src/pages/HomePage.jsx` – entry route
- `src/views/CameraView.jsx` – camera + 2D overlays
- `src/scenes/OverlayScene.jsx` – R3F overlay
- `src/components/organisms/HeadAnchor.jsx` – 3D head placement
- `src/cv/*.js` – CV, workers, filters (`detector.worker.js`, `anchor.normal.js`)
- `public/models/` – ONNX assets (not tracked)

## Commands
- `npm run dev` – dev server
- `npm run build` – build to `dist/`
- `npm run preview` – preview build
- `npm run lint` – ESLint (JS/JSX)

## Conventions
- 2-space indent; functional components; hooks in `src/hooks/` as `use*.js`.
- Workers named `*.worker.js`; import via `new URL('path', import.meta.url)`.
- Keep heavy CV in WebWorkers; main thread stays responsive.
- **No Mocking Logic**: All critical logic must be fully implemented. Only cosmetic changes or follow-ups can be omitted with a `#todo` tag in comments.

## PR Tips
- JS-only: convert any `*.js`/`*.jsx` you touch to JS/JSX.
- Include repro steps and, for UI changes, screenshots/video.
- Note any new files in `public/models/` in the PR description.
