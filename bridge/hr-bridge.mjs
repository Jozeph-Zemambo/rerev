#!/usr/bin/env node
// Watch heart rate → Convex.
//
// The HeartRateOnStream Wear OS app sends heart rate to "OBS" over obs-websocket v5. This
// script plays OBS on port 4455 (same approach as FrantisekSilhan/heartrateonstream-extension,
// MIT), and forwards each reading to the Convex /heart-rate endpoint, which the phone app
// subscribes to.
//
//   npm run bridge              real watch: point HeartRateOnStream at this Mac's IP, port 4455
//   npm run bridge -- --simulate   fake heart rate that climbs, spikes and recovers (no watch)

import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const PORT = 4455;
const SEND_EVERY_MS = 1000;

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')]),
);
const site = env.VITE_CONVEX_SITE_URL;
const token = env.HR_BRIDGE_TOKEN;
if (!site || !token) {
  console.error('Missing VITE_CONVEX_SITE_URL or HR_BRIDGE_TOKEN in .env.local (run `npx convex dev` first).');
  process.exit(1);
}

let latest = null;
let lastSent = 0;

async function forward(bpm) {
  latest = bpm;
  const now = Date.now();
  if (now - lastSent < SEND_EVERY_MS) return;
  lastSent = now;
  try {
    const res = await fetch(`${site}/heart-rate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bpm, device: 'watch', token }),
    });
    if (!res.ok) console.error(`Convex rejected ${bpm} bpm: ${res.status} ${await res.text()}`);
    else process.stdout.write(`\r♥ ${String(bpm).padStart(3)} bpm → Convex   `);
  } catch (error) {
    console.error(`\nCouldn't reach Convex: ${error.message}`);
  }
}

if (process.argv.includes('--simulate')) {
  // Warm up, settle in zone, spike above it, recover — loops every ~3 minutes.
  const start = Date.now();
  setInterval(() => {
    const t = ((Date.now() - start) / 1000) % 180;
    const base = t < 30 ? 95 + t * 1.3 : t < 90 ? 134 + Math.sin(t / 6) * 4 : t < 120 ? 134 + (t - 90) * 1.2 : 170 - (t - 120) * 0.6;
    forward(Math.round(base + (Math.random() - 0.5) * 3));
  }, SEND_EVERY_MS);
  console.log('Simulating heart rate (no watch). Ctrl+C to stop.');
} else {
  startObsImpostor();
}

/** Just enough of obs-websocket v5 for HeartRateOnStream to connect and push its "hr" text source. */
function startObsImpostor() {
  const scene = { sceneName: 'Scene', sceneUuid: '6a68a8e3-1bcf-4383-a37f-0f4687ba63ce' };
  const responses = {
    GetCurrentProgramScene: { currentProgramSceneName: scene.sceneName, currentProgramSceneUuid: scene.sceneUuid, ...scene },
    GetSceneList: { currentPreviewSceneName: null, currentPreviewSceneUuid: null, currentProgramSceneName: scene.sceneName, currentProgramSceneUuid: scene.sceneUuid, scenes: [{ sceneIndex: 0, ...scene }] },
    GetSceneItemList: {
      sceneItems: [
        { inputKind: 'text_gdiplus_v3', isGroup: null, sceneItemEnabled: true, sceneItemId: 1, sceneItemIndex: 0, sourceName: 'hr', sourceType: 'OBS_SOURCE_TYPE_INPUT', sourceUuid: '835b4fba-0c1a-46a2-b47a-a4619890d890' },
      ],
    },
    GetVersion: { obsWebSocketVersion: '5.5.4', rpcVersion: 1 },
  };

  const server = new WebSocketServer({ port: PORT });
  server.on('connection', socket => {
    console.log('\nWatch connected.');
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.4', rpcVersion: 1 } }));
    socket.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (msg.op !== 6) return;
      const { requestType, requestId, requestData } = msg.d ?? {};
      if (requestType === 'SetInputSettings' && requestData?.inputName === 'hr') {
        const bpm = Number.parseInt(String(requestData.inputSettings?.text ?? ''), 10);
        if (Number.isFinite(bpm)) void forward(bpm);
      }
      socket.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { code: 100, result: true }, responseData: responses[requestType] ?? {} } }));
    });
    socket.on('close', () => console.log('\nWatch disconnected.'));
  });

  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal)
    .map(a => a.address);
  console.log(`Waiting for HeartRateOnStream on port ${PORT}. In the watch app, set the OBS address to ${addresses.join(' or ')} and port ${PORT}.`);
}

setInterval(() => {
  if (latest === null) process.stdout.write('\r… no heart rate yet   ');
}, 5000);
