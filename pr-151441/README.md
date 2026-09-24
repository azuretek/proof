# Reconnect resume marker on a native UI client: before and after

Captures for `openclaw/openclaw#151441`, taken from one iOS client that connects to the gateway as `openclaw-ios` in mode ui, run in the iOS Simulator against two gateways built side by side:

- **base**, `aa9b92a12d8` on `main`, without the fix
- **head**, `acd2b985868`, the PR head

## The run

The same script ran on each side, on a fresh gateway state, with a local mock model that answers every request with `Received: <the message typed>`, so a reply on screen shows the send reached the agent run. No network model and no credentials were involved.

1. Start the gateway, launch the client, approve its pairing.
2. Send `First message, before the reconnect`, then screenshot (`*-1-before-reconnect.png`).
3. Start the screen recording (`*-reconnect.mp4`), then restart the gateway so the client reconnects and resumes its session.
4. Send `Second message, after the reconnect`, then screenshot (`*-2-after-reconnect.png`).
5. Send `Third message, sent again`, then screenshot (`*-3-sent-again.png`).

## What each side shows

- **base**: the first send is answered. After the reconnect both sends show `Not sent · Retry`, and the gateway refuses each with `INVALID_REQUEST ... unexpected property '__controlUiReconnectResume'` (`gateway-base-chat-send.log`).
- **head**: all three sends are answered, and the gateway accepts each with `res ✓ chat.send` (`gateway-head-chat-send.log`).

## Files

- `base-1-before-reconnect.png`, `base-2-after-reconnect.png`, `base-3-sent-again.png`, the captures without the fix
- `head-1-before-reconnect.png`, `head-2-after-reconnect.png`, `head-3-sent-again.png`, the captures with the fix
- `base-reconnect.mp4`, `head-reconnect.mp4`, the recordings of the reconnect and the two later sends
- `gateway-base-chat-send.log`, `gateway-head-chat-send.log`, every `chat.send` request and response line from each gateway log, with color codes stripped and nothing else changed

## Environment

A macOS build host, iOS Simulator, with both gateways bound to loopback and run one at a time on the same port.
