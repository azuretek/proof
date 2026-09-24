# chela #76: notice banners drawn as the Control UI toast, before and after

Captures for `azuretek/chela#76`: both notice banner surfaces, desktop and iOS, in light and dark appearance, at two revisions:

- **before**, `4725fe1` on `main`
- **after**, `171fac7`, the PR head

## The run

`job.sh` ran once and captured both revisions in turn, each from a detached git worktree that it removed at the end.

- **Desktop**: the Electron capture harness, `desktop/scripts/capture-pages.js`, run at each revision. The `banner-light.png` and `banner-dark.png` pages it writes are copied here as `desktop-*`.
- **iOS**: a Debug build installed on an iPhone 17 simulator running iOS 27, launched with `-claw-seed-notices` so every notice tone is on screen, then `xcrun simctl io <device> screenshot` in light and then dark appearance, saved as `ios-*`.

The seeded notices name `example-host` and `host.example.ts.net`, placeholders the app and the harness use for these captures.

## What each side shows

- **before**: each card carries a tone stripe on its leading edge and a bordered text action.
- **after**: an opaque card with no stripe, a 16px icon with no box, and a filled action, the Control UI toast.

## Files

- `desktop-before-light.png`, `desktop-before-dark.png`, `desktop-after-light.png`, `desktop-after-dark.png`, the desktop captures
- `ios-before-light.png`, `ios-before-dark.png`, `ios-after-light.png`, `ios-after-dark.png`, the iOS captures
- `job.sh`, the script that produced every file here

## Environment

A macOS arm64 host, Xcode with the iPhone 17 simulator on iOS 27, and the Electron build from the repo's own `desktop/node_modules`.
