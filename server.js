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
const LOCAL_ADMIN_SESSION = crypto.randomBytes(32).toString('hex');
const MAX_BODY = 128 * 1024;
const MAX_SCREENSHOT_FILE = 12 * 1024 * 1024;
const MAX_PRESCRIPTION_FILE = 1024 * 1024 * 1024;
const prescriptionDir = path.join(__dirname, 'data', 'prescriptions');
const screenshotDir = path.join(__dirname, 'data', 'screenshots');
fs.mkdirSync(prescriptionDir, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });
const commands = new Map();
const queues = new Map();
const devices = new Map();
// 每台设备保留最近一段轨迹；真实坐标只能由授权遥测适配器上报，不在服务端伪造。
const telemetry = new Map();
const screenshots = new Map();
const inventories = new Map();
const jobBindings = new Map();
const prescriptions = new Map();
const pendingPrescriptionPairs = new Map();
for (const name of fs.readdirSync(prescriptionDir).filter(value => value.endsWith('.json'))) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(prescriptionDir, name), 'utf8'));
    if (record.id && Array.isArray(record.files) && record.files.length === 2) {
      record.files = record.files.map(file => ({ ...file, diskPath: path.join(prescriptionDir, file.diskFile) }));
      if (record.files.every(file => fs.existsSync(file.diskPath))) prescriptions.set(record.id, record);
    } else if (record.id && record.fileName && record.diskFile) {
      record.diskPath = path.join(prescriptionDir, record.diskFile);
      if (fs.existsSync(record.diskPath)) prescriptions.set(record.id, record);
    }
  } catch { }
}
const ALLOWED_TYPES = new Set(['OPEN_DJI', 'OPEN_AGRAS', 'OPEN_APP', 'OPEN_DEEPLINK', 'INSPECT_PAGE',
  'CLICK_TEXT', 'CLICK_ID', 'CLICK_RATIO', 'WAIT_PAGE', 'BACK', 'DOWNLOAD_PRESCRIPTION', 'IMPORT_PRESCRIPTION',
  'READ_AGRAS_INVENTORY', 'PREPARE_AGRAS_JOB', 'READ_AGRAS_RTK_STATUS',
  'START_SCREEN_CAPTURE', 'CAPTURE_SCREEN', 'STOP_SCREEN_CAPTURE']);
const BLOCKED_TERMS = ['锁定', '解锁', '起飞', '开始任务', '执行任务', '返航', '降落', '紧急停止',
  '喷洒', '播撒', '转让', '删除', 'lock', 'unlock', 'takeoff', 'take_off', 'startmission',
  'start_mission', 'returntohome', 'return_to_home', 'landing', 'land', 'emergencystop',
  'emergency_stop', 'spray', 'spread', 'transfer', 'delete'];

function validateCommand(type, payload) {
  if (!ALLOWED_TYPES.has(type)) return { error: 'unsupported_type', allowed: [...ALLOWED_TYPES] };
  const app = String(payload.app || '').toLowerCase();
  if (app && !['smartfarm', 'agras', 'com.dji.agflow', 'com.dji.agrasx'].includes(app)) return { error: 'unsupported_app' };
  const normalized = JSON.stringify(payload).toLowerCase().replace(/[\s-]/g, '');
  if (BLOCKED_TERMS.some(term => normalized.includes(term.toLowerCase().replace(/[\s-]/g, '')))) return { error: 'dangerous_operation_blocked' };
  if (type === 'CLICK_TEXT' && !String(payload.text || '').trim()) return { error: 'text_required' };
  if (type === 'CLICK_ID' && !String(payload.resourceId || '').trim()) return { error: 'resourceId_required' };
  if (type === 'CLICK_RATIO') {
    if (!String(payload.description || '').trim()) return { error: 'description_required_for_coordinate_click' };
    if (![payload.x, payload.y].every(value => typeof value === 'number' && value >= 0 && value <= 1)) return { error: 'coordinate_ratio_out_of_range' };
  }
  if (type === 'WAIT_PAGE' && payload.timeoutMs != null && (!Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 0 || payload.timeoutMs > 60000)) return { error: 'timeoutMs_out_of_range' };
  if (type === 'IMPORT_PRESCRIPTION') {
    if (!String(payload.fileName || '').trim()) return { error: 'fileName_required' };
    if (!String(payload.fileName).toLowerCase().endsWith('.tif')) return { error: 'tif_file_required' };
    if (payload.source != null && !['dji', 'other'].includes(String(payload.source).toLowerCase())) return { error: 'unsupported_prescription_source' };
    if (payload.unit != null && !['mu', 'ha'].includes(String(payload.unit).toLowerCase())) return { error: 'unsupported_area_unit' };
    if (payload.resample != null && !['max', 'average'].includes(String(payload.resample).toLowerCase())) return { error: 'unsupported_resample_type' };
  }
  if (type === 'PREPARE_AGRAS_JOB') {
    if (!String(payload.jobName || '').trim()) return { error: 'jobName_required' };
    if (!String(payload.prescriptionName || '').trim()) return { error: 'prescriptionName_required' };
  }
  return null;
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
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

function telemetryPoint(body) {
  const latitude = Number(body.latitude), longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw Object.assign(new Error('latitude_out_of_range'), { status: 400 });
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw Object.assign(new Error('longitude_out_of_range'), { status: 400 });
  return { latitude, longitude, altitude: Number.isFinite(Number(body.altitude)) ? Number(body.altitude) : null,
    speed: Number.isFinite(Number(body.speed)) ? Number(body.speed) : null,
    heading: Number.isFinite(Number(body.heading)) ? Number(body.heading) : null,
    isFlying: typeof body.isFlying === 'boolean' ? body.isFlying : null,
    source: String(body.source || 'sdk').slice(0, 40), timestamp: new Date().toISOString() };
}

function authorizedAdmin(req) {
  if (req.headers['x-admin-key'] === ADMIN_KEY) return true;
  const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
  return cookies.includes(`t100_local_admin=${LOCAL_ADMIN_SESSION}`);
}

function isLoopbackRequest(req) {
  const address = String(req.socket.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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

async function readBuffer(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('screen_capture_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('screen_capture_empty'), { status: 400 });
  return Buffer.concat(chunks);
}

function queueFor(deviceId) {
  if (!queues.has(deviceId)) queues.set(deviceId, []);
  return queues.get(deviceId);
}

function publicCommand(command) {
  return { id: command.id, type: command.type, payload: command.payload };
}

function safeFileName(value) {
  const decoded = decodeURIComponent(String(value || '')).trim();
  if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) return null;
  return decoded.replace(/[^\p{L}\p{N}._() -]/gu, '_').slice(0, 180);
}

function prescriptionFileInfo(fileName) {
  const match = /^(.*)\.(tif|tfw)$/i.exec(fileName || '');
  return match && match[1] ? { baseName: match[1], extension: match[2].toLowerCase() } : null;
}

async function receiveFile(req, target) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const output = fs.createWriteStream(target, { flags: 'wx' });
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_PRESCRIPTION_FILE) throw Object.assign(new Error('prescription_file_too_large'), { status: 413 });
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    if (!size) throw Object.assign(new Error('prescription_file_empty'), { status: 400 });
    return { size, sha256: hash.digest('hex') };
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(target); } catch { }
    throw error;
  }
}

function enqueue(deviceId, type, payload) {
  const command = { id: crypto.randomUUID(), deviceId, type, payload, status: 'QUEUED', createdAt: new Date().toISOString() };
  commands.set(command.id, command);
  queueFor(deviceId).push(command);
  return command;
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

function deviceView(record) {
  const lastSeenMs = Date.parse(record.lastSeen || 0);
  return { ...record, online: Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= 15000 };
}

function inventoryItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map(item => {
    if (typeof item === 'string') return { name: item.trim().slice(0, 180) };
    return {
      id: String(item && item.id || '').slice(0, 180),
      name: String(item && item.name || '').trim().slice(0, 180),
      area: String(item && item.area || '').slice(0, 80),
      updatedAt: String(item && item.updatedAt || '').slice(0, 80)
    };
  }).filter(item => item.name);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      if (isLoopbackRequest(req)) {
        res.setHeader('Set-Cookie', `t100_local_admin=${LOCAL_ADMIN_SESSION}; HttpOnly; SameSite=Strict; Path=/`);
      }
      return text(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
      return json(res, 200, spec);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, time: new Date().toISOString(), lanUrls: listAddresses() });
    }
    if (req.method === 'POST' && url.pathname === '/api/device/status') {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const record = {
        deviceId, lastSeen: new Date().toISOString(),
        foregroundService: Boolean(body.foregroundService),
        accessibilityEnabled: Boolean(body.accessibilityEnabled),
        accessibilityConnected: Boolean(body.accessibilityConnected),
        sdCardStatusReported: typeof body.sdCardInserted === 'boolean',
        sdCardInserted: Boolean(body.sdCardInserted),
        sdCardWritable: Boolean(body.sdCardWritable),
        prescriptionImportReady: Boolean(body.prescriptionImportReady),
        agrasInstalled: Boolean(body.agrasInstalled),
        companionVersion: String(body.companionVersion || ''),
        androidVersion: String(body.androidVersion || ''),
        remoteAddress: req.socket.remoteAddress || ''
      };
      devices.set(deviceId, record);
      return json(res, 200, deviceView(record));
    }
    if (req.method === 'POST' && url.pathname === '/api/device/agras-inventory') {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const record = { deviceId, jobs: inventoryItems(body.jobs), prescriptions: inventoryItems(body.prescriptions),
        updatedAt: new Date().toISOString() };
      inventories.set(deviceId, record);
      return json(res, 200, record);
    }
    if (req.method === 'POST' && url.pathname === '/api/device/telemetry') {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const point = telemetryPoint(body);
      const record = telemetry.get(deviceId) || { deviceId, points: [] };
      record.points.push(point);
      record.points = record.points.slice(-2000);
      record.updatedAt = point.timestamp;
      telemetry.set(deviceId, record);
      return json(res, 200, { deviceId, point, updatedAt: record.updatedAt });
    }
    if (req.method === 'POST' && url.pathname === '/api/device/screenshot') {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      if (!/^image\/jpe?g(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        return json(res, 415, { error: 'jpeg_required' });
      }
      const data = await readBuffer(req, MAX_SCREENSHOT_FILE);
      const diskPath = path.join(screenshotDir, crypto.createHash('sha256').update(deviceId).digest('hex') + '.jpg');
      fs.writeFileSync(diskPath, data);
      const record = { deviceId, diskPath, size: data.length, updatedAt: new Date().toISOString() };
      screenshots.set(deviceId, record);
      return json(res, 200, { deviceId, size: record.size, updatedAt: record.updatedAt });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/devices') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const items = [...devices.values()].map(deviceView).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      return json(res, 200, { items, onlineTimeoutSeconds: 15 });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/agras-inventory') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      return json(res, 200, inventories.get(deviceId) || { deviceId, jobs: [], prescriptions: [], updatedAt: null });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/telemetry') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const record = telemetry.get(deviceId);
      return json(res, 200, record || { deviceId, points: [], updatedAt: null });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/screenshot') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const record = screenshots.get(deviceId);
      if (!record || !fs.existsSync(record.diskPath)) return json(res, 404, { error: 'screenshot_not_found' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': record.size,
        'Cache-Control': 'no-store', 'X-Captured-At': record.updatedAt });
      return fs.createReadStream(record.diskPath).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/screenshot/status') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const record = screenshots.get(deviceId);
      return json(res, 200, record ? { deviceId, size: record.size, updatedAt: record.updatedAt }
        : { deviceId, size: 0, updatedAt: null });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/job-bindings') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      const items = [...jobBindings.values()].filter(item => !deviceId || item.deviceId === deviceId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json(res, 200, { items });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/job-bindings') {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const body = await readJson(req);
      const deviceId = String(body.deviceId || '').trim();
      const jobName = String(body.jobName || '').trim();
      const prescriptionName = String(body.prescriptionName || '').trim();
      if (!deviceId || !jobName || !prescriptionName) return json(res, 400, { error: 'deviceId_jobName_prescriptionName_required' });
      const id = String(body.id || crypto.randomUUID());
      const record = { id, deviceId, jobName: jobName.slice(0, 180), prescriptionName: prescriptionName.slice(0, 180),
        status: 'SAVED', updatedAt: new Date().toISOString() };
      jobBindings.set(id, record);
      return json(res, 201, record);
    }
    const uploadMatch = url.pathname.match(/^\/api\/admin\/prescriptions\/([^/]+)$/);
    if (req.method === 'PUT' && uploadMatch) {
      if (!authorizedAdmin(req)) return json(res, 401, { error: 'invalid_admin_key' });
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      const pairId = String(url.searchParams.get('pairId') || '').trim();
      const fileName = safeFileName(uploadMatch[1]);
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(pairId)) return json(res, 400, { error: 'valid_pairId_required' });
      if (!fileName) return json(res, 400, { error: 'invalid_file_name' });
      const fileInfo = prescriptionFileInfo(fileName);
      if (!fileInfo) return json(res, 400, { error: 'tif_or_tfw_file_required' });
      const pairKey = `${deviceId}:${pairId}`;
      const pending = pendingPrescriptionPairs.get(pairKey) || { deviceId, pairId, baseName: fileInfo.baseName, files: {} };
      if (pending.baseName !== fileInfo.baseName) return json(res, 400, {
        error: 'prescription_base_name_mismatch', expectedBaseName: pending.baseName, actualBaseName: fileInfo.baseName
      });
      if (pending.files[fileInfo.extension]) return json(res, 409, { error: 'prescription_file_already_uploaded' });
      const diskPath = path.join(prescriptionDir, `${pairId}-${fileInfo.extension}-${fileName}`);
      const received = await receiveFile(req, diskPath);
      pending.files[fileInfo.extension] = { fileName, diskPath, ...received };
      pendingPrescriptionPairs.set(pairKey, pending);
      if (!pending.files.tif || !pending.files.tfw) {
        return json(res, 202, { pairId, baseName: pending.baseName, received: Object.keys(pending.files), waitingFor: fileInfo.extension === 'tif' ? 'tfw' : 'tif' });
      }
      const id = crypto.randomUUID();
      const files = ['tif', 'tfw'].map(extension => pending.files[extension]);
      const record = { id, baseName: pending.baseName, files, createdAt: new Date().toISOString() };
      prescriptions.set(id, record);
      fs.writeFileSync(path.join(prescriptionDir, `${id}.json`), JSON.stringify({
        id, baseName: record.baseName, files: files.map(file => ({
          fileName: file.fileName, diskFile: path.basename(file.diskPath), size: file.size, sha256: file.sha256
        })), createdAt: record.createdAt
      }));
      pendingPrescriptionPairs.delete(pairKey);
      const command = enqueue(deviceId, 'DOWNLOAD_PRESCRIPTION', {
        prescriptionId: id, baseName: record.baseName,
        files: files.map(file => ({ fileName: file.fileName, size: file.size, sha256: file.sha256 }))
      });
      return json(res, 201, { id, pairId, baseName: record.baseName,
        files: files.map(file => ({ fileName: file.fileName, size: file.size, sha256: file.sha256 })), commandId: command.id });
    }
    const downloadMatch = url.pathname.match(/^\/api\/device\/prescriptions\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && downloadMatch) {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const record = prescriptions.get(decodeURIComponent(downloadMatch[1]));
      const requestedName = safeFileName(downloadMatch[2]);
      const file = record && Array.isArray(record.files) && record.files.find(item => item.fileName === requestedName);
      if (!file || !fs.existsSync(file.diskPath)) return json(res, 404, { error: 'prescription_file_not_found' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': file.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'X-Content-SHA256': file.sha256
      });
      return fs.createReadStream(file.diskPath).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/device/commands/next') {
      if (!authorizedDevice(req)) return json(res, 401, { error: 'invalid_device_token' });
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) return json(res, 400, { error: 'deviceId_required' });
      const existing = devices.get(deviceId) || { deviceId };
      devices.set(deviceId, { ...existing, lastSeen: new Date().toISOString(), remoteAddress: req.socket.remoteAddress || '' });
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
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
      const validationError = validateCommand(type, payload);
      if (validationError) return json(res, 400, validationError);
      if (type === 'IMPORT_PRESCRIPTION') {
        const device = devices.get(deviceId);
        if (!device || !device.prescriptionImportReady) {
          return json(res, 409, { error: 'prescription_import_not_ready',
            message: '设备未确认 SD 卡 DJI/RX/ 中存在完整且校验通过的 TIF/TFW 文件对' });
        }
      }
      if (type === 'PREPARE_AGRAS_JOB') {
        const inventory = inventories.get(deviceId);
        const jobName = String(payload.jobName || '').trim();
        const prescriptionName = String(payload.prescriptionName || '').trim();
        if (!inventory || !inventory.updatedAt) {
          return json(res, 409, { error: 'agras_inventory_required', message: '请先从遥控器同步作业和处方图列表' });
        }
        if (!inventory.jobs.some(item => item.name === jobName)) {
          return json(res, 409, { error: 'job_not_in_inventory', message: `同步清单中不存在作业：${jobName}` });
        }
        if (!inventory.prescriptions.some(item => item.name === prescriptionName)) {
          return json(res, 409, { error: 'prescription_not_in_inventory', message: `同步清单中不存在处方图：${prescriptionName}` });
        }
      }
      const command = enqueue(deviceId, type, payload);
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
