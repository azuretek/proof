import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { boot, openSocket, waitFor } from './helpers.js';

test('a registered background phone keeps push delivery while its authenticated socket remains open', async () => {
  const sends = [];
  const s = await boot({ push: { relay: 'https://relay.example.com' }, pushFetch: async (url, init) => {
    if (url.endsWith('/send')) sends.push(JSON.parse(init.body));
    return { status: 200, json: async () => url.endsWith('/register') ? { ticket: 'synthetic-ticket' } : { ok: true } };
  } });
  let socket;
  try {
    await s.post('/api/v1/push', s.tokens.device, { token: 'synthetic-phone', platform: 'ios', key: randomBytes(32).toString('base64url') });
    socket = await openSocket(s.base);
    socket.ws.send(JSON.stringify({ type: 'auth', token: s.tokens.device }));
    await waitFor(() => socket.frames.some((f) => f.type === 'hello'));
    s.world.incoming(1, 'Synthetic background message');
    await waitFor(() => socket.frames.some((f) => f.name === 'message.new'));
    // Seeing the event on a socket proves transport, not that a suspended phone presented a notice.
    assert.equal(sends.length, 1, 'an open socket must not suppress the phone push');
    socket.ws.close();
    await waitFor(() => socket.ws.readyState === 3);
    s.world.incoming(1, 'Synthetic disconnected message');
    await waitFor(() => sends.length === 2);
    socket = await openSocket(s.base);
    socket.ws.send(JSON.stringify({ type: 'auth', token: s.tokens.device }));
    await waitFor(() => socket.frames.some((f) => f.type === 'hello'));
    s.world.incoming(1, 'Synthetic reconnected message');
    await waitFor(() => sends.length === 3);
    s.store.putSettings({ 'notifications.newMessage': false });
    s.world.incoming(1, 'Synthetic disabled message');
    await waitFor(() => socket.frames.filter((f) => f.name === 'message.new').length === 2);
    assert.equal(sends.length, 3, 'preference still suppresses push with an open socket');
  } finally { socket?.ws.close(); await s.close(); }
});
