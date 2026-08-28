'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`配置文件读取失败: ${error.message}`);
}

const HOST = process.env.T100_HOST || fileConfig.host || '0.0.0.0';
const PORT = Number(process.env.T100_PORT || fileConfig.port || 8787);
const DEVICE_TOKEN = process.env.T100_DEVICE_TOKEN || fileConfig.deviceToken || 'change-device-token';
const ADMIN_KEY = process.env.T100_ADMIN_KEY || fileConfig.adminKey || 'change-admin-key';
const MAX_BODY = 128 * 1024;
const commands = new Map();
const queues = new Map();

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function authorizedDevice(req) {
  return req.headers.authorization === `Bearer ${DEVICE_TOKEN}`;
}

function authorizedAdmin(req) {
  return req.headers['x-admin-key'] === ADMIN_KEY;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function queueFor(deviceId) {
  if (!queues.has(deviceId)) queues.set(deviceId, []);
  return queues.get(deviceId);
}

function publicCommand(command) {
  return { id: command.id, type: command.type, payload: command.payload };
}

function listAddresses() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(`http://${entry.address}:${PORT}`);
    }
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return text(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
      return json(res, 200, spec);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, time: new Date().toISOString(), lanUrls: listAddresses() });
    }
    if (req.method === 'GET' && url.pathname === '/api/device/commands/next') {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const queue = queueFor(deviceId);
      const command = queue.find(item => item.status === 'QUEUED');
      if (!command) { res.writeHead(204); return res.end(); }
      command.status = 'DELIVERED';
      command.deliveredAt = new Date().toISOString();
      return json(res, 200, publicCommand(command));
    }
    const ackMatch = url.pathname.match(/^\/api\/device\/commands\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const id = decodeURIComponent(ackMatch[1]);
      const command = commands.get(id);
      if (!command) return json(res, 404, { error: 'command_not_found' });
      const body = await readJson(req);
      command.status = body.success ? 'SUCCEEDED' : 'FAILED';
      command.success = Boolean(body.success);
      command.message = String(body.message || '');
      command.acknowledgedAt = new Date().toISOString();
      return json(res, 200, command);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/commands') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').trim();
      const type = String(body.type || '').trim();
      if (!deviceId || !type) return json(res, 400, { error: 'deviceId_and_type_required' });
      const allowed = new Set(['OPEN_DJI', 'OPEN_DEEPLINK', 'INSPECT_PAGE', 'CLICK_TEXT']);
      if (!allowed.has(type)) return json(res, 400, { error: 'unsupported_type', allowed: [...allowed] });
      const command = {
        id: crypto.randomUUID(), deviceId, type,
        payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
        status: 'QUEUED', createdAt: new Date().toISOString()
      };
      commands.set(command.id, command);
      queueFor(deviceId).push(command);
      return json(res, 201, command);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/commands') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = url.searchParams.get('deviceId');
      const values = [...commands.values()].filter(item => !deviceId || item.deviceId === deviceId);
      values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { items: values.slice(0, 200) });
    }
    const commandMatch = url.pathname.match(/^\/api\/admin\/commands\/([^/]+)$/);
    if (req.method === 'GET' && commandMatch) {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const command = commands.get(decodeURIComponent(commandMatch[1]));
      return command ? json(res, 200, command) : json(res, 404, { error: 'command_not_found' });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.message || 'internal_error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`T100 companion LAN server listening on http://127.0.0.1:${PORT}`);
  for (const url of listAddresses()) console.log(`LAN: ${url}`);
  if (DEVICE_TOKEN === 'change-device-token' || ADMIN_KEY === 'change-admin-key') {
    console.warn('WARNING: 请在 config.json 中设置 deviceToken 和 adminKey。');
  }
});
