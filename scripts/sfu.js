/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* The group-call SFU (roadmap 3.2): its own process and container
   (P00RIJA-Chat_Sfu), its own port (CHAT_SFU_PORT, 11223), reached through
   nginx at /sfu on the stack's public port — WebSocket over the same TLS as
   everything else, so it needs no UDP and no port of its own on the internet,
   which is what survives a network that cuts client-started UDP flows.

   It forwards SFrame-encrypted frames (scripts/lib/sfu-rooms.js) and holds no
   key. The capability secret it checks rooms with is the one the relay mints
   them with, read from the relay's data directory (sfu-secret), so the two
   share it without anything in .env. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const rooms = require('./lib/sfu-rooms.js');

const PORT = Number(process.env.CHAT_SFU_PORT || 11223);
/* As the relay's CHAT_LISTEN_HOSTS: addresses, or an interface name such as
   docker0 standing for its IPv4 address (nginx reaches this through
   host-gateway, the Docker bridge). Never the internet. */
function interfaceIpv4(name) {
  const listed = (require('os').networkInterfaces()[name] || []).find((entry) => entry.family === 'IPv4' || entry.family === 4);
  if (listed) return listed.address;
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(name)) return '';
  for (const binary of ['ip', '/sbin/ip', '/usr/sbin/ip', '/bin/ip']) {
    try {
      const out = require('child_process').execFileSync(binary, ['-4', '-o', 'addr', 'show', 'dev', name], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const match = out.match(/inet (\d+\.\d+\.\d+\.\d+)\//);
      if (match) return match[1];
    } catch (_error) { /* not this binary */ }
  }
  return '';
}
const HOSTS = Array.from(new Set(String(process.env.CHAT_SFU_LISTEN_HOSTS || '127.0.0.1').split(/[,\s]+/).map((h) => h.trim()).filter(Boolean)
  .map((h) => (require('net').isIP(h) ? h : interfaceIpv4(h))).filter(Boolean)));
const SECRET_PATH = process.env.CHAT_SFU_SECRET_PATH || path.join(process.env.CHAT_DATA_DIR || '/data', 'sfu-secret');

function readSecret() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const value = fs.readFileSync(SECRET_PATH);
      if (value.length >= 32) return value;
    } catch (_error) { /* the relay has not written it yet */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`no SFU secret at ${SECRET_PATH}; the relay writes it on start`);
}
const secret = readSecret();

const forward = rooms.createRooms({
  maxPerRoom: Number(process.env.CHAT_SFU_MAX_PER_ROOM || 25),
  maxRooms: Number(process.env.CHAT_SFU_MAX_ROOMS || 500),
  send: (socket, data) => { try { if (socket.readyState === 1) socket.send(data); } catch (_error) { /* gone */ } },
  bufferedOf: (socket) => socket.bufferedAmount || 0,
});

const server = http.createServer((req, res) => {
  if (req.url === '/sfu/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'poorija-sfu', ...forward.stats() }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: rooms.MAX_FRAME_BYTES + 64 });
server.on('upgrade', (req, socket, head) => {
  if (!String(req.url || '').startsWith('/sfu')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  let joined = false;
  const helloTimer = setTimeout(() => { if (!joined) ws.close(4001, 'no-hello'); }, 10000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) { if (joined) forward.frame(ws, data); return; }
    let message;
    try { message = JSON.parse(String(data)); } catch (_error) { return; }
    if (!joined && message?.type === 'hello') {
      if (!rooms.capabilityHolds(secret, message.room, Number(message.exp), message.cap)) { ws.close(4003, 'bad-capability'); return; }
      const result = forward.join(ws, message.room);
      if (!result.ok) { ws.close(4008, result.reason); return; }
      joined = true;
      clearTimeout(helloTimer);
      ws.send(JSON.stringify({ type: 'welcome', slot: result.slot, peers: result.peers }));
      return;
    }
    if (joined && message?.type === 'bye') { ws.close(1000, 'bye'); return; }
    if (joined) forward.relayControl(ws, message);
  });
  ws.on('close', () => { clearTimeout(helloTimer); forward.leave(ws); });
  ws.on('error', () => {});
});

/* One server, several addresses. An http.Server listens once — a second
   listen() moves it, which left the SFU on the Docker bridge alone and the
   relay's health check on 127.0.0.1 refused. So the first address is the
   server's own and each further one is a plain listener handing its sockets
   to it, the way the relay does (scripts/server/01-boot.js). */
const [firstHost, ...otherHosts] = HOSTS.length ? HOSTS : ['127.0.0.1'];
server.listen({ port: PORT, host: firstHost }, () => console.log(`[SFU] listening on ${firstHost}:${PORT}`));
for (const host of otherHosts) {
  const extra = require('net').createServer((socket) => server.emit('connection', socket));
  extra.on('error', (error) => console.warn(`[SFU] ${host}:${PORT} not available: ${error.code || error.message}`));
  extra.listen({ port: PORT, host }, () => console.log(`[SFU] listening on ${host}:${PORT}`));
}
const stop = () => { wss.clients.forEach((ws) => { try { ws.close(1001, 'restarting'); } catch (_e) { /* gone */ } }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
