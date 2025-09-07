# Repository Guidelines

## Project Structure & Module Organization
- `src/` – application code
  - `components/` React components (PascalCase filenames)
  - `pages/` top-level routes (e.g., `HomePage.jsx`)
  - `views/`, `scenes/` rendering/3D views (Three.js + R3F)
  - `hooks/` reusable hooks (`use*.js`)
  - `cv/` computer-vision logic and web workers (e.g., `detector.worker.js`, filters, tracking)
  - `audio/` TTS and lip‑sync utilities
  - `services/` integration helpers
  - `main.jsx`, `index.css` app entry
- `public/` – static assets served at root. Models live in `public/models/` (see `public/models/README.md`).
- Root: `index.html`, `vite.config.js`, `eslint.config.js`.

## Build, Test, and Development Commands
- `npm run dev` – start Vite dev server with HMR.
- `npm run build` – production build to `dist/`.
- `npm run preview` – preview the production build locally.
- `npm run lint` – run ESLint on the project.

Examples:
- Start dev server: `npm run dev`
- Build + preview: `npm run build && npm run preview`

## Coding Style & Naming Conventions
- Language: React + Vite. JavaScript only (JS/JSX). No TypeScript.
- Indentation: 2 spaces; LF line endings.
- Components: PascalCase (e.g., `HeadAnchor.jsx`), hooks: `useCamelCase` in `hooks/`.
- Files: prefer PascalCase for React components, kebab/camel for modules; workers as `*.worker.js`.
- Linting: ESLint (JS-focused via `eslint.config.js`). Keep `no-unused-vars` clean; leading uppercase or `_` constants are ignored by rule config.
- Imports: use relative paths within `src/`.
- Migration: if you modify a `*.ts`/`*.tsx` file, convert it to JS/JSX in the same PR.

## Testing Guidelines
- No formal test setup yet. If adding tests, prefer Vitest + React Testing Library.
- Place tests alongside code or under `src/` with `*.test.js` or `*.test.jsx`.
- Keep tests fast and deterministic; mock Web APIs (e.g., WebGL, WebAudio) as needed.

## Commit & Pull Request Guidelines
- Commits: aim for Conventional Commits (`feat:`, `fix:`, `chore:`). Existing history uses `chore:`; align with that when relevant.
- PRs should include:
  - Clear description and rationale; link issues.
  - Screenshots or short clips for UI/visual changes.
  - Steps to validate (commands, test notes).
  - Notes on assets or model changes (e.g., files added to `public/models/`).

## Security & Configuration Tips
- Do not commit large model files or secrets. Place ONNX models under `public/models/` locally.
- Keep dependencies minimal; prefer web‑friendly, WASM‑compatible CV code.
