import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import mqtt from 'mqtt';
import Aedes from 'aedes';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4700);
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const DASHBOARD_DIR = path.resolve(process.env.DASHBOARD_DIR || path.join(__dirname, '../../../dashboard'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../../data'));
const RETENTION_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'homeos.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    ts          INTEGER NOT NULL,
    room        TEXT    NOT NULL,
    device      TEXT    NOT NULL,
    measurement TEXT    NOT NULL,
    value       REAL    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_rmt ON readings (room, measurement, ts DESC);
`);
const insertReading = db.prepare(
  'INSERT INTO readings (ts, room, device, measurement, value) VALUES (?, ?, ?, ?, ?)'
);
const selectHistory = db.prepare(
  'SELECT ts, value FROM readings WHERE room = ? AND measurement = ? AND ts > ? ORDER BY ts'
);
const deleteOld = db.prepare('DELETE FROM readings WHERE ts < ?');

const aedes = new Aedes();
net.createServer(aedes.handle).listen(MQTT_PORT, () => {
  console.log(`core: embedded MQTT broker on :${MQTT_PORT}`);
});

const twin = new Map();
function setTwin(room, field, value) {
  if (!twin.has(room)) twin.set(room, {});
  twin.get(room)[field] = value;
}
function snapshot() {
  return Object.fromEntries(twin);
}

const clients = new Set();
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

let batch = [];
const mq = mqtt.connect(`mqtt://localhost:${MQTT_PORT}`);

mq.on('connect', () => {
  mq.subscribe(['homeos/tele/#', 'homeos/state/#']);
  console.log('core: ingest connected to broker');
});

mq.on('message', (topic, payload) => {
  const parts = topic.split('/');
  try {
    if (parts[1] === 'tele') {
      const [, , room, device, measurement] = parts;
      const value = Number.parseFloat(payload.toString());
      if (!Number.isFinite(value) || !room || !device || !measurement) return;
      batch.push({ ts: Date.now(), room, device, measurement, value });
      setTwin(room, measurement, value);
      broadcast({ type: 'tele', room, device, measurement, value, ts: Date.now() });
    } else if (parts[1] === 'state') {
      const [, , room, device] = parts;
      const state = JSON.parse(payload.toString());
      setTwin(room, device, state);
      broadcast({ type: 'state', room, device, state, ts: Date.now() });
    }
  } catch (err) {
    console.error('core: bad message on', topic, err.message);
  }
});

setInterval(() => {
  if (batch.length === 0) return;
  const rows = batch;
  batch = [];
  try {
    db.exec('BEGIN');
    for (const r of rows) insertReading.run(r.ts, r.room, r.device, r.measurement, r.value);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('core: insert failed', err.message);
  }
}, 2000);

setInterval(() => {
  deleteOld.run(Date.now() - RETENTION_MS);
}, 10 * 60 * 1000);

const app = Fastify();
await app.register(websocket);
await app.register(fastifyStatic, { root: DASHBOARD_DIR });

app.get('/ws', { websocket: true }, (socket) => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.send(JSON.stringify({ type: 'snapshot', twin: snapshot(), ts: Date.now() }));
});

app.get('/api/twin', async () => snapshot());

app.get('/api/history', async (req, reply) => {
  const { room, measurement = 'temp', minutes = 15 } = req.query;
  if (!room) return reply.code(400).send({ error: 'room is required' });
  const mins = Math.min(Math.max(Number(minutes) || 15, 1), 1440);
  const rows = selectHistory.all(room, measurement, Date.now() - mins * 60_000);
  return rows.map((r) => ({ time: new Date(r.ts).toISOString(), value: r.value }));
});

app.post('/api/cmd', async (req, reply) => {
  const { room, device = 'all', action } = req.body || {};
  if (!room || !action || typeof action !== 'object') {
    return reply.code(400).send({ error: 'room and action are required' });
  }
  mq.publish(`homeos/cmd/${room}/${device}`, JSON.stringify(action));
  return { ok: true };
});

app.get('/healthz', async () => ({
  ok: true,
  wsClients: clients.size,
  mqttClients: aedes.connectedClients
}));

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`core: http + ws on :${PORT}, dashboard from ${DASHBOARD_DIR}`);
