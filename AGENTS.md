# HOL (High on Life)

Before broad work, read parent `AGENTS.md` files up to the mono root; nearest scoped instructions apply last.

## Code Style


- JavaScript only (ES modules). No TypeScript.
- Avoid defensive logic, try-catch blocks, and ambiguous inputs
- **No Mocking Logic**: All critical logic must be fully implemented. Only cosmetic changes or follow-ups can be omitted with a `#todo` tag in comments
- WebWorkers for heavy CV operations

## Mobile Testing

- Primary target: iPhone Safari/Chrome
- Requires HTTPS for camera access (rear-facing: `facingMode: 'environment'`)
- Test autoplay policies and user gesture requirements
- Verify WebGL context stability during orientation changes

## Performance Budget (per frame @ 60 FPS = 16.67ms)

- Detection (every 4th): 2-4ms amortized
- Tracking/CV: ≤4ms
- OpenCV operations: ≤6ms
- R3F render + lip-sync: ≤6ms
- Safety margin: ≥4ms

## Architecture

Runtime architecture is summarized in README.md.
