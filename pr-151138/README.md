# Staged-media ownership boundary: capture harness

Reproduces the captures attached to the fix PR for the staged-media ownership
boundary route (`/__openclaw__/assistant-media`).

- `capture.mjs` drives the route for each case in a phase, writes one PNG per
  phase, and writes a raw log holding every request and response.
- `seed-fixture.sh` writes the fixture the cases address.

## The fixture

Three objects in the media store, plus the registry that binds them:

- `owned-staged.png`, staged and bound to a session (`OWNER`), so a request that
  names that session is served and any other request is refused.
- `fresh-staged.png`, staged with no owner bound, so every request is refused.
- `unstaged-control.png`, never staged, so it keeps the access it had.

The registry lives at `<state>/media/inbound-ownership.json`. Replacing it with a
directory produces the unreadable-registry phase, where a failed read refuses the
request rather than being read as an empty registry.

## Running it

```bash
# in a checkout of the revision under test
pnpm install && pnpm build
OPENCLAW_STATE_DIR=/srv/openclaw-proof/state pnpm gateway:dev

# in another shell
OWNER=agent:dev:dashboard:staged-media-proof \
STATE=/srv/openclaw-proof/state \
  bash seed-fixture.sh

read -r TOKEN < /path/to/gateway.token
PORT=19001 TOKEN="$TOKEN" AGENT=dev \
OWNER=agent:dev:dashboard:staged-media-proof \
STATE=/srv/openclaw-proof/state OUT=/srv/proof/151138 \
REV=$(git rev-parse HEAD) BRANCH=$(git rev-parse --abbrev-ref HEAD) \
  node capture.mjs
```

For the second phase, replace the registry with a directory before the run and
restore it afterwards:

```bash
mv /srv/openclaw-proof/state/media/inbound-ownership.json /tmp/registry.bak
mkdir /srv/openclaw-proof/state/media/inbound-ownership.json
PHASE=unreadable ... node capture.mjs
rmdir /srv/openclaw-proof/state/media/inbound-ownership.json
mv /tmp/registry.bak /srv/openclaw-proof/state/media/inbound-ownership.json
```

## What the log holds

One JSON line and one readable block per case: the request URL, whether a session
was named, the HTTP status, the content type, the content length, the sha256 of
the response body, and the body itself when it is text. Served bytes are recorded
the same way, without the body.

## Redaction

Every request carries an Authorization header and the served-bytes request carries
a media ticket. Both are capabilities for the object, so the harness replaces the
header value, every `mediaTicket` query value and every `mediaTicket` body field
with `<redacted>` in code, before anything is written, and refuses to write a log
that still holds either. The redacted text is what the PNG renders, so the log and
the image agree.

## Environment

The captures were taken on a Linux VM, Ubuntu 24.04, x86_64, 4 vCPU, on a build
host, with the gateway bound to loopback.
