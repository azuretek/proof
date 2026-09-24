#!/bin/bash
# chela PR #76 before/after notice-banner captures, desktop (Electron harness) and iOS (simulator, seeded notices).
# before = main 4725fe1, after = PR head 171fac7. Worktrees in /tmp, removed at the end; ~/src/chela is not touched.
set -u
W="$HOME/.openclaw/state/repo-drive/azuretek__chela/pr76-proof"
OUT="$W/shots"
REPO="$HOME/src/chela"
BASE=4725fe1b450a9ced9c506826817b77e66865da2a
HEAD=171fac7d72e8e67c71cbbf0e4cee096a8a8282ca
BUNDLE=com.azuretek.claw-mobile
mkdir -p "$OUT"
status=0
sw_vers; uname -m; xcodebuild -version | head -1
UDID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next(x["udid"] for k,v in d["devices"].items() if "iOS-27" in k for x in v if x["name"]=="iPhone 17"))')
echo "== sim iPhone 17 iOS 27 $UDID"
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
for side in before after; do
  if [ "$side" = before ]; then rev=$BASE; else rev=$HEAD; fi
  wt="/tmp/chela76-$side"
  git -C "$REPO" worktree add --detach "$wt" "$rev" || { status=1; continue; }
  echo "== $side $(git -C "$wt" log --oneline -1 | cut -c1-60)"
  ln -s "$REPO/desktop/node_modules" "$wt/desktop/node_modules"
  [ -d "$REPO/node_modules" ] && ln -s "$REPO/node_modules" "$wt/node_modules"
  (cd "$wt/desktop" && ./node_modules/.bin/electron --version && ./node_modules/.bin/electron scripts/capture-pages.js --out "$W/desktop-$side"); echo "desktop $side exit $?"
  for m in light dark; do cp "$W/desktop-$side/banner-$m.png" "$OUT/desktop-$side-$m.png" || status=1; done
  (cd "$wt/mobile" && xcodegen generate && xcodebuild -quiet -project Chela.xcodeproj -scheme Chela -sdk iphonesimulator -configuration Debug -destination "platform=iOS Simulator,id=$UDID" CODE_SIGNING_ALLOWED=NO -derivedDataPath "$wt/mobile/build-sim" build); echo "ios build $side exit $?"
  app="$wt/mobile/build-sim/Build/Products/Debug-iphonesimulator/Chela.app"
  if [ -d "$app" ]; then
    xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null
    xcrun simctl install "$UDID" "$app"
    for m in light dark; do
      xcrun simctl ui "$UDID" appearance "$m"
      xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" -claw-seed-notices >/dev/null
      sleep 8
      xcrun simctl io "$UDID" screenshot "$OUT/ios-$side-$m.png" || status=1
    done
  else
    echo "ios $side: no app bundle"; status=1
  fi
  unlink "$wt/desktop/node_modules"; [ -L "$wt/node_modules" ] && unlink "$wt/node_modules"
  git -C "$REPO" worktree remove --force "$wt"
done
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null
xcrun simctl shutdown "$UDID"
git -C "$REPO" worktree list
ls -la "$OUT"
echo "status $status"
