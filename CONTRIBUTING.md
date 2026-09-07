# Contributing to Yonder PDF

Thanks for helping. A few ground rules keep the project easy to trust:

- **No network features.** Documents must never leave the machine. The only remote traffic is the ad frame and the GitHub update check.
- **Security boundaries stay put.** The renderer is sandboxed; paths never cross IPC from the renderer; every IPC handler validates its sender and arguments; the CSP in `src/renderer/index.html` is not relaxed for production.
- **Every change ships with a check.** `npm run typecheck && npm run build`, and `npm run e2e` on macOS when touching the viewer, overlay, writer or page operations.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`) so the changelog can be generated.

## Workflow

1. Fork, branch from `main`.
2. `npm install`, `npm run dev`.
3. Open a pull request. CI builds on macOS, Windows and Linux.

## Releasing (maintainers)

Tag `vX.Y.Z` on `main`. The `release` workflow builds all three platforms and attaches installers plus `latest*.yml` update manifests to the GitHub Release. Nothing is uploaded anywhere else.
