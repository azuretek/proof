#!/bin/bash
# Fixture for the staged-media ownership boundary proof.
#
# Writes one staged object with an owner bound, one staged object with no owner,
# and one never-staged control, plus the ownership registry that binds them.
# Run it while no other writer holds the registry.
#
# Usage: OWNER=<session key> [STATE=<state directory>] bash seed-fixture.sh
set -eu

STATE="${STATE:-/srv/openclaw-proof/state}"
OWNER="${OWNER:-}"
if [ -z "$OWNER" ]; then
  echo "OWNER is required: the session key that owns the staged object" >&2
  exit 2
fi

MEDIA="$STATE/media"
INBOUND="$MEDIA/inbound"
mkdir -p "$INBOUND"

# A 1x1 PNG, 68 bytes, so the served-bytes case has known content.
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
printf '%s' "$PNG_B64" | base64 -d > "$INBOUND/owned-staged.png"
cp "$INBOUND/owned-staged.png" "$INBOUND/fresh-staged.png"
cp "$INBOUND/owned-staged.png" "$INBOUND/unstaged-control.png"

NOW=$(( $(date +%s) * 1000 ))
cat > "$MEDIA/inbound-ownership.json" <<EOF
{
  "owned-staged.png": { "stagedAt": $NOW, "sessionKey": "$OWNER" },
  "fresh-staged.png": { "stagedAt": $NOW }
}
EOF
chmod 600 "$MEDIA/inbound-ownership.json"

echo "wrote $INBOUND (owned-staged.png, fresh-staged.png, unstaged-control.png)"
echo "wrote $MEDIA/inbound-ownership.json"
