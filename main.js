#!/usr/bin/env electron
'use strict';

/** 被 node 或误用 shell 调用时，改由 electron 启动本文件（shell 执行 .js 请用: electron 本文件 或 ./main.js） */
if (!process.versions || !process.versions.electron) {
  const { spawnSync } = require('child_process');
  const script = __filename;
  const r = spawnSync('electron', [script], {
    stdio: 'inherit',
    cwd: __dirname,
    env: process.env
  });
  if (r.error) {
    process.stderr.write(
      '无法启动 electron。请使用:\n  electron "' + script + '"\n或（需可执行权限）:\n  chmod +x "' + script + '" && "' + script + '"\n'
    );
    process.exit(127);
  }
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const LEGACY_CONFIG_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_CONFIG = {
  proxy: {
    http: { enabled: false, host: '127.0.0.1', port: 8080, url: '' },
    socks5: {
      enabled: false,
      host: '127.0.0.1',
      port: 1080,
      url: '',
      dnsMode: 'auto',
      useCurlFallback: true
    }
  },
  settingsJsonPath: '',
  javSavePath: '',
  youtubeSavePath: '',
  window: { width: 1200, height: 900, title: 'YouTube + JAV 封面', showMenuBar: true },
  settingsDialog: { width: 520, height: 640 },
  icons: {
    paste: '',
    search: '',
    extractCode: '',
    openJav: '',
    openYoutube: '',
    settings: ''
  }
};

let mainWindow = null;

function electronConfigRoot() {
  return app.getPath('userData');
}

function defaultSettingsJsonFile() {
  return path.join(electronConfigRoot(), 'json', 'settings.json');
}

function defaultJavDir() {
  return path.join(electronConfigRoot(), 'jav');
}

function defaultYoutubeDir() {
  return path.join(electronConfigRoot(), 'youtube');
}

/** 未配置的路径回落到 userData 下 json / jav / youtube */
function resolvePaths(cfg) {
  const c = cfg || config || DEFAULT_CONFIG;
  const jsonRaw = (c.settingsJsonPath || '').trim();
  const javRaw = (c.javSavePath || '').trim();
  const ytRaw = (c.youtubeSavePath || '').trim();
  let settingsJsonFile = jsonRaw || defaultSettingsJsonFile();
  if (settingsJsonFile.endsWith(path.sep) || (!path.extname(settingsJsonFile) && !settingsJsonFile.endsWith('.json'))) {
    settingsJsonFile = path.join(settingsJsonFile, 'settings.json');
  }
  return {
    settingsJsonFile,
    javSavePath: javRaw || defaultJavDir(),
    youtubeSavePath: ytRaw || defaultYoutubeDir()
  };
}

function normalizeProxyConfig(raw) {
  const d = DEFAULT_CONFIG.proxy;
  if (raw && (raw.http || raw.socks5)) {
    const out = {
      http: { ...d.http, ...(raw.http || {}) },
      socks5: { ...d.socks5, ...(raw.socks5 || {}) }
    };
    if (out.http.enabled && out.socks5.enabled) {
      out.http.enabled = false;
    }
    return out;
  }
  const http = { ...d.http };
  const socks5 = { ...d.socks5 };
  if (raw && raw.enabled) {
    const host = raw.host || d.http.host;
    const port = raw.port ?? d.socks5.port;
    const url = raw.url || '';
    if (String(raw.type || 'http').toLowerCase() === 'socks5') {
      socks5.enabled = true;
      socks5.host = host;
      socks5.port = port;
      socks5.url = url;
    } else {
      http.enabled = true;
      http.host = host;
      http.port = port;
      http.url = url;
    }
  }
  return { http, socks5 };
}

function mergeStoredConfig(raw) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    proxy: normalizeProxyConfig(raw.proxy || raw),
    window: { ...DEFAULT_CONFIG.window, ...(raw.window || {}) },
    settingsDialog: { ...DEFAULT_CONFIG.settingsDialog, ...(raw.settingsDialog || {}) },
    icons: { ...DEFAULT_CONFIG.icons, ...(raw.icons || {}) }
  };
  return merged;
}

function loadConfigFromDisk() {
  const candidates = [defaultSettingsJsonFile(), LEGACY_CONFIG_FILE];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return mergeStoredConfig(raw);
      }
    } catch (e) {
      console.error('loadConfigFromDisk', file, e);
    }
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

let config = loadConfigFromDisk();

function saveConfig() {
  const { settingsJsonFile } = resolvePaths(config);
  ensureDir(path.dirname(settingsJsonFile));
  fs.writeFileSync(settingsJsonFile, JSON.stringify(config, null, 2), 'utf8');
}

function configForRenderer() {
  return {
    ...config,
    effectivePaths: resolvePaths(config),
    configRoot: electronConfigRoot()
  };
}

const PROXY_BYPASS_RULES =
  '<local>;127.0.0.1;192.168.0.0/16;10.0.0.0/8;172.16.0.0/12;*.local';

function socksDnsModesForEndpoint(ep) {
  const mode = (ep && ep.dnsMode) || 'auto';
  if (mode === 'local') return ['local'];
  if (mode === 'remote') return ['remote'];
  return ['remote', 'local'];
}

function socksProxyRule(hostPort, dnsKind) {
  const prefix = dnsKind === 'local' ? 'socks5=' : 'socks5h=';
  return `${prefix}${hostPort}`;
}

function resolveSocksConnectSpec(endpoint) {
  const ep = endpoint || {};
  const urlRaw = (ep.url || '').trim();
  if (urlRaw) {
    let normalized = urlRaw;
    if (!/^socks/i.test(normalized)) {
      normalized = `socks5://${normalized.replace(/^\/\//, '')}`;
    }
    try {
      const parsed = new URL(normalized);
      const host = parsed.hostname;
      const port = parsed.port || '1080';
      const user = parsed.username ? decodeURIComponent(parsed.username) : '';
      const pass = parsed.password ? decodeURIComponent(parsed.password) : '';
      return { host, port, user, pass };
    } catch (_) {
      /* fall through */
    }
  }
  return {
    host: ep.host || '127.0.0.1',
    port: String(ep.port || 1080),
    user: '',
    pass: ''
  };
}

function proxyRulesFromEndpoint(endpoint, kind) {
  const ep = endpoint || {};
  const urlRaw = (ep.url || '').trim();
  if (urlRaw && kind !== 'socks5') {
    const fromUrl = proxyRulesFromUrl(urlRaw, ep);
    if (fromUrl) return fromUrl;
  }
  if (kind === 'socks5' && urlRaw) {
    const spec = resolveSocksConnectSpec(ep);
    const hostPort = spec.user
      ? `${spec.user}:${spec.pass}@${spec.host}:${spec.port}`
      : `${spec.host}:${spec.port}`;
    const [primary] = socksDnsModesForEndpoint(ep);
    return socksProxyRule(hostPort, primary);
  }
  if (ep.enabled && ep.host) {
    const defaultPort = kind === 'http' ? 8080 : 1080;
    const hostPort = `${ep.host}:${ep.port || defaultPort}`;
    if (kind === 'socks5') {
      const [primary] = socksDnsModesForEndpoint(ep);
      return socksProxyRule(hostPort, primary);
    }
    return `http=${hostPort};https=${hostPort}`;
  }
  if (ep.enabled && urlRaw) {
    const fromUrl = proxyRulesFromUrl(urlRaw, ep);
    if (fromUrl) return fromUrl;
  }
  return '';
}

function proxyRulesString() {
  const p = normalizeProxyConfig(config.proxy);
  if (p.socks5.enabled) {
    return proxyRulesFromEndpoint(p.socks5, 'socks5');
  }
  if (p.http.enabled) {
    return proxyRulesFromEndpoint(p.http, 'http');
  }
  return '';
}

/** 从完整代理 URL 生成 Chromium proxyRules */
function proxyRulesFromUrl(urlStr, endpoint) {
  let normalized = urlStr.trim();
  if (!normalized) return '';
  const socksDirect = normalized.match(/^socks5h?:\/\/(.+)$/i);
  if (socksDirect) {
    const [primary] = socksDnsModesForEndpoint(endpoint || {});
    return socksProxyRule(socksDirect[1].replace(/\/$/, ''), primary);
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname;
    if (!host) return '';
    let port = parsed.port;
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (!port) {
      if (scheme === 'https') port = '443';
      else if (scheme === 'http') port = '80';
      else port = '1080';
    }
    let hostPort = `${host}:${port}`;
    if (parsed.username) {
      const user = decodeURIComponent(parsed.username);
      const pass = parsed.password ? decodeURIComponent(parsed.password) : '';
      hostPort = pass ? `${user}:${pass}@${hostPort}` : `${user}@${hostPort}`;
    }
    if (scheme === 'socks5' || scheme === 'socks5h') {
      const [primary] = socksDnsModesForEndpoint(endpoint || {});
      return socksProxyRule(hostPort, primary);
    }
    if (scheme === 'socks4') {
      return `socks4=${hostPort}`;
    }
    if (scheme === 'http' || scheme === 'https') {
      return `http=${hostPort};https=${hostPort}`;
    }
  } catch (_) {
    /* fall through */
  }
  return '';
}

const NET_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

function isLikelyValidImage(buf, minBytes) {
  if (!buf || buf.length < (minBytes || 800)) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return buf.length >= (minBytes || 2000);
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return buf.length >= (minBytes || 800);
  }
  return buf.length >= (minBytes || 1500);
}

function fetchUrlBufferViaRequest(url, sess, extraHeaders) {
  const headers = { ...NET_HEADERS, ...extraHeaders };
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: sess, useSessionCookies: true });
    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }
    const chunks = [];
    request.on('response', (response) => {
      if (response.statusCode >= 400) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

async function fetchUrlBufferOnce(url, sess, extraHeaders) {
  const headers = { ...NET_HEADERS, ...extraHeaders };
  let lastErr;
  try {
    return await fetchUrlBufferViaRequest(url, sess, headers);
  } catch (e) {
    lastErr = e;
  }
  if (typeof net.fetch === 'function') {
    try {
      const response = await net.fetch(url, { session: sess, headers });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('网络请求失败');
}

async function applyProxyRulesToSession(sess, rules) {
  if (rules) {
    await sess.setProxy({
      mode: 'fixed_servers',
      proxyRules: rules,
      proxyBypassRules: PROXY_BYPASS_RULES
    });
  } else {
    await sess.setProxy({ mode: 'direct' });
  }
  if (typeof sess.closeAllConnections === 'function') {
    sess.closeAllConnections();
  }
}

async function applyProxyToSession(sess) {
  await applyProxyRulesToSession(sess, proxyRulesString());
}

function fetchUrlBufferViaCurlOnce(url, endpoint, extraHeaders, dnsKind) {
  const spec = resolveSocksConnectSpec(endpoint);
  const flag = dnsKind === 'local' ? '--socks5' : '--socks5-hostname';
  let proxyArg = `${spec.host}:${spec.port}`;
  if (spec.user) {
    proxyArg = `${spec.user}:${spec.pass}@${proxyArg}`;
  }
  const args = [
    '-sS',
    '-L',
    '--max-time',
    '45',
    '-A',
    NET_HEADERS['User-Agent'],
    flag,
    proxyArg
  ];
  if (extraHeaders && extraHeaders.Referer) {
    args.push('-H', `Referer: ${extraHeaders.Referer}`);
  }
  args.push(url);
  const result = spawnSync('curl', args, {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('未找到 curl，请安装 curl 或关闭「SOCKS 使用 curl」');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const errText = (result.stderr && result.stderr.toString()) || `curl 退出码 ${result.status}`;
    throw new Error(errText.trim());
  }
  if (!result.stdout || !result.stdout.length) {
    throw new Error('curl 返回空内容');
  }
  return Buffer.from(result.stdout);
}

function fetchUrlBufferViaCurl(url, endpoint, extraHeaders) {
  const modes = socksDnsModesForEndpoint(endpoint);
  let lastErr;
  for (const mode of modes) {
    try {
      return fetchUrlBufferViaCurlOnce(url, endpoint, extraHeaders, mode);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('curl SOCKS 请求失败');
}

async function fetchUrlBufferElectron(url, extraHeaders) {
  const sess = session.defaultSession;
  await applyProxyToSession(sess);
  const rules = proxyRulesString();
  const p = normalizeProxyConfig(config.proxy);
  const tryModes =
    p.socks5.enabled && p.socks5.dnsMode === 'auto'
      ? ['remote', 'local']
      : [socksDnsModesForEndpoint(p.socks5)[0] || 'remote'];

  let lastErr;
  for (const dnsKind of p.socks5.enabled ? tryModes : ['remote']) {
    if (p.socks5.enabled) {
      const spec = resolveSocksConnectSpec(p.socks5);
      const hostPort = spec.user
        ? `${spec.user}:${spec.pass}@${spec.host}:${spec.port}`
        : `${spec.host}:${spec.port}`;
      const altRules = socksProxyRule(hostPort, dnsKind);
      await applyProxyRulesToSession(sess, altRules);
    }
    try {
      return await fetchUrlBufferOnce(url, sess, extraHeaders);
    } catch (e) {
      lastErr = e;
    }
  }

  if (!p.socks5.enabled && rules && rules.includes('socks5h=')) {
    try {
      const altRules = rules.replace(/socks5h=/g, 'socks5=');
      await applyProxyRulesToSession(sess, altRules);
      return await fetchUrlBufferOnce(url, sess, extraHeaders);
    } catch (e) {
      lastErr = e;
    } finally {
      await applyProxyToSession(sess);
    }
  }

  throw lastErr || new Error('网络请求失败');
}

async function fetchUrlBuffer(url, extraHeaders) {
  const p = normalizeProxyConfig(config.proxy);
  const errors = [];

  if (p.socks5.enabled && p.socks5.useCurlFallback !== false) {
    try {
      return fetchUrlBufferViaCurl(url, p.socks5, extraHeaders);
    } catch (e) {
      errors.push(`curl: ${e.message}`);
    }
  }

  try {
    return await fetchUrlBufferElectron(url, extraHeaders);
  } catch (e) {
    errors.push(`Chromium: ${e.message}`);
  } finally {
    await applyProxyToSession(session.defaultSession);
  }

  throw new Error(errors.join('；') || '网络请求失败');
}

function getVideoId(url) {
  url = (url || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/i,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/i,
    /(?:m\.youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/i,
    /(?:music\.youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/i,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/i,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) {
      const id = u.searchParams.get('v');
      if (id && id.length === 11) return id;
    }
  } catch (_) {}
  return null;
}

function isYoutubeInput(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  if (getVideoId(t)) return true;
  return t.includes('youtube') || t.includes('youtu.be');
}

const MISSAV_DOMAINS = ['missav.ws', 'missav.com', 'missav.icu', 'missav.tv', 'missav.net', 'missav.org'];

function extractCodeFromUrl(text) {
  const t = text.trim();
  if (MISSAV_DOMAINS.some((d) => t.includes(d))) {
    const patterns = [
      /missav\.[a-z]{2,3}\/dm\d+\/[a-z]{2}\/([^?/\s\-]+(?:-\d+)?)/i,
      /missav\.[a-z]{2,3}\/[a-z]{2}\/([a-z]+-\d+)/i
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) return m[1];
    }
  }
  return t;
}

function normalizeJavCode(code) {
  code = (code || '').trim().toLowerCase();
  if (code.includes(' ')) {
    const parts = code.split(/\s+/);
    if (parts.length >= 2) code = `${parts[0]}-${parts[1]}`;
  }
  return code;
}

function looksLikeJavCode(text) {
  const c = normalizeJavCode(extractCodeFromUrl(text));
  return /^[a-z]{2,10}-\d{2,5}$/i.test(c);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function fetchYoutubeThumbnail(videoId) {
  const urls = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/default.jpg`,
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/default.jpg`
  ];
  const ytHeaders = {
    Referer: 'https://www.youtube.com/',
    Origin: 'https://www.youtube.com'
  };
  let lastErr = null;
  for (const url of urls) {
    try {
      const buf = await fetchUrlBuffer(url, ytHeaders);
      const minSize = url.includes('maxresdefault') ? 3500 : 1200;
      if (!isLikelyValidImage(buf, minSize)) continue;
      return { buffer: buf, url, kind: 'youtube', id: videoId };
    } catch (e) {
      lastErr = e;
    }
  }
  const detail = lastErr && lastErr.message ? `（${lastErr.message}）` : '';
  throw new Error(`无法加载 YouTube 缩略图${detail}。请检查网络或代理，并确认视频 ID：${videoId}`);
}

async function fetchJavCover(code) {
  const normalized = normalizeJavCode(extractCodeFromUrl(code));
  if (!normalized) throw new Error('无效的代号');
  const url = `https://fourhoi.com/${normalized}/cover.jpg`;
  const buf = await fetchUrlBuffer(url);
  if (!buf || buf.length < 500) throw new Error('图片数据无效');
  return { buffer: buf, url, kind: 'jav', id: normalized };
}

function saveImageResult(result) {
  const paths = resolvePaths(config);
  const ext = result.url.endsWith('.png') ? '.png' : '.jpg';
  let dir;
  let name;
  if (result.kind === 'youtube') {
    dir = paths.youtubeSavePath;
    name = `${result.id}${ext}`;
  } else {
    dir = paths.javSavePath;
    name = `${result.id}_cover.jpg`;
  }
  ensureDir(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, result.buffer);
  return filePath;
}

function applyMenuBarFromConfig() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const show = config.window?.showMenuBar !== false;
  mainWindow.setAutoHideMenuBar(!show);
  mainWindow.setMenuBarVisibility(show);
}

function applyMainWindowFromConfig() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const w = config.window || DEFAULT_CONFIG.window;
  const width = Math.max(400, parseInt(w.width, 10) || DEFAULT_CONFIG.window.width);
  const height = Math.max(300, parseInt(w.height, 10) || DEFAULT_CONFIG.window.height);
  const title = (w.title && String(w.title).trim()) || DEFAULT_CONFIG.window.title;
  mainWindow.setTitle(title);
  mainWindow.setSize(width, height);
  applyMenuBarFromConfig();
}

function createWindow() {
  const w = config.window || DEFAULT_CONFIG.window;
  const width = Math.max(400, parseInt(w.width, 10) || DEFAULT_CONFIG.window.width);
  const height = Math.max(300, parseInt(w.height, 10) || DEFAULT_CONFIG.window.height);
  const title = (w.title && String(w.title).trim()) || DEFAULT_CONFIG.window.title;

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 400,
    minHeight: 300,
    title,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  applyMenuBarFromConfig();
}

app.whenReady().then(async () => {
  await applyProxyToSession(session.defaultSession);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', () => configForRenderer());

ipcMain.handle('save-config', (_e, newConfig) => {
  config = {
    ...config,
    ...newConfig,
    proxy: normalizeProxyConfig({
      http: { ...config.proxy?.http, ...(newConfig.proxy?.http || {}) },
      socks5: { ...config.proxy?.socks5, ...(newConfig.proxy?.socks5 || {}) }
    }),
    window: { ...DEFAULT_CONFIG.window, ...config.window, ...(newConfig.window || {}) },
    settingsDialog: { ...DEFAULT_CONFIG.settingsDialog, ...config.settingsDialog, ...(newConfig.settingsDialog || {}) },
    icons: { ...config.icons, ...(newConfig.icons || {}) }
  };
  saveConfig();
  applyProxyToSession(session.defaultSession);
  applyMainWindowFromConfig();
  return configForRenderer();
});

ipcMain.handle('read-clipboard-text', () => clipboard.readText());

ipcMain.handle('copy-image-buffer', (_e, base64) => {
  const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
  clipboard.writeImage(img);
});

ipcMain.handle('open-path', (_e, dirPath) => {
  if (!dirPath) return;
  ensureDir(dirPath);
  shell.openPath(dirPath);
});

ipcMain.handle('open-save-folder', (_e, kind) => {
  const paths = resolvePaths(config);
  let folder;
  if (kind === 'settingsJson') {
    folder = path.dirname(paths.settingsJsonFile);
  } else if (kind === 'jav') {
    folder = paths.javSavePath;
  } else if (kind === 'youtube') {
    folder = paths.youtubeSavePath;
  } else {
    return;
  }
  ensureDir(folder);
  shell.openPath(folder);
});

ipcMain.handle('extract-jav-code', (_e, text) => {
  const extracted = extractCodeFromUrl(text || '');
  return normalizeJavCode(extracted);
});

ipcMain.handle('search-cover', async (_e, input) => {
  const text = (input || '').trim();
  if (!text) throw new Error('请输入链接或代号');

  await applyProxyToSession(session.defaultSession);

  let result;
  if (isYoutubeInput(text)) {
    const videoId = getVideoId(text);
    if (!videoId) throw new Error('无效的 YouTube 链接');
    result = await fetchYoutubeThumbnail(videoId);
  } else if (MISSAV_DOMAINS.some((d) => text.includes(d)) || looksLikeJavCode(text)) {
    result = await fetchJavCover(text);
  } else if (getVideoId(text)) {
    result = await fetchYoutubeThumbnail(getVideoId(text));
  } else {
    result = await fetchJavCover(text);
  }

  const savedPath = saveImageResult(result);
  return {
    kind: result.kind,
    id: result.id,
    sourceUrl: result.url,
    savedPath,
    base64: result.buffer.toString('base64'),
    mime: 'image/jpeg'
  };
});
