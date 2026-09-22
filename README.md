# Proof artifacts

Captures, harnesses and raw logs, one directory per item, published so a reviewer can read the evidence and re-run what produced it rather than trust a summary.

Usually referenced from an upstream pull request, because an outside contribution cannot attach images to the PR itself: attaching uploads into the target repository's asset store, which needs write access we do not have. A raw URL from here is the route that works unattended, and markdown renders it.

## pr-151138

Staged-media ownership boundary for `openclaw/openclaw#151138`, captured on a gateway built from the fix revision.

- `1-ownership-boundary.png` and `2-unreadable-registry.png`, the captures
- `capture.mjs`, the harness that drives the route and writes both the captures and the raw log
- `seed-fixture.sh`, the fixture the cases address
- `capture-boundary.log` and `capture-unreadable.log`, the raw responses, with the authorization header never logged and ticket values redacted in code
- `README.md`, the run recipe

Everything here is either produced by the harness or written by it. No household host name, path, address or account appears in these files.
