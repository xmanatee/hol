# Project Notes for Agents (Gemini)

## Stack & Policy
- React 19 + Vite, JavaScript only (JS/JSX). No TypeScript.
- Tailwind CSS for styling (utility-first approach).
- ESM imports with explicit `.js`/`.jsx` extensions.
- Service layer architecture with centralized state management.

## Layout (Refactored Architecture)
- `src/pages/HomePage.jsx` – entry route
- `src/views/CameraView.jsx` – main camera interface (refactored with hooks)
- `src/scenes/OverlayScene.jsx` – R3F WebGL overlay
- `src/components/ui/UnifiedControlPanel.jsx` – combined metrics/controls/config interface
- `src/components/` – modular UI components (`CameraVideo.jsx`, `DetectionCanvas.jsx`)
- `src/services/` – service layer (`CameraService.js`, `DetectionService.js`, `AnchorManager.js`)
- `src/hooks/useCameraSystem.js` – main orchestration hook
- `src/hooks/useHudMetrics.js` – unified metrics system
- `src/cv/*.js` – CV, workers, filters (`detector.worker.js`, `anchor.normal.js`)
- `src/utils/detectionRenderer.js` – canvas rendering utilities
- `public/models/` – ONNX assets (not tracked)

## Commands
- `npm run dev` – dev server
- `npm run build` – build to `dist/`
- `npm run preview` – preview build
- `npm run lint` – ESLint (JS/JSX)

## Conventions
- 2-space indent; functional components; hooks in `src/hooks/` as `use*.js`.
- Service classes in PascalCase (e.g., `CameraService.js`).
- Tailwind CSS classes over inline styles; use utility-first patterns.
- Workers named `*.worker.js`; import via `new URL('path', import.meta.url)`.
- Keep heavy CV in WebWorkers; main thread stays responsive.
- Follow service layer pattern: separate business logic from UI components.
- Use `useCameraSystem` hook for orchestrating all camera-related functionality.
- **No Mocking Logic**: All critical logic must be fully implemented. Only cosmetic changes or follow-ups can be omitted with a `#todo` tag in comments.

## PR Tips
- JS-only: convert any `*.js`/`*.jsx` you touch to JS/JSX.
- Include repro steps and, for UI changes, screenshots/video.
- Note any new files in `public/models/` in the PR description.
