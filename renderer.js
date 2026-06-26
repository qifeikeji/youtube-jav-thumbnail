'use strict';

const $ = (id) => document.getElementById(id);

const searchInput = $('searchInput');
const statusBar = $('statusBar');
const placeholder = $('placeholder');
const previewFigure = $('previewFigure');
const previewImg = $('previewImg');
const previewCaption = $('previewCaption');
const contextMenu = $('contextMenu');
const settingsDialog = $('settingsDialog');

const btnPaste = $('btnPaste');
const btnSearch = $('btnSearch');
const btnExtract = $('btnExtract');
const btnOpenJav = $('btnOpenJav');
const btnOpenYt = $('btnOpenYt');
const btnSettings = $('btnSettings');

let currentBase64 = null;
let config = null;

const iconMap = {
  paste: { btn: btnPaste, key: 'paste', input: 'iconPaste' },
  search: { btn: btnSearch, key: 'search', input: 'iconSearch' },
  extractCode: { btn: btnExtract, key: 'extractCode', input: 'iconExtractCode' },
  openJav: { btn: btnOpenJav, key: 'openJav', input: 'iconOpenJav' },
  openYoutube: { btn: btnOpenYt, key: 'openYoutube', input: 'iconOpenYoutube' },
  settings: { btn: btnSettings, key: 'settings', input: 'iconSettings' }
};

function setStatus(msg, isError) {
  statusBar.textContent = msg;
  statusBar.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
}

function applyButtonIcon(btn, filePath) {
  btn.classList.remove('has-icon');
  const old = btn.querySelector('img.icon-img');
  if (old) old.remove();
  if (!filePath) return;
  const img = document.createElement('img');
  img.className = 'icon-img';
  const normalized = filePath.replace(/\\/g, '/');
  img.src = normalized.startsWith('/') ? 'file://' + normalized : 'file:///' + normalized;
  img.alt = '';
  btn.prepend(img);
  btn.classList.add('has-icon');
}

function applyAllIcons(icons) {
  for (const { btn, key } of Object.values(iconMap)) {
    applyButtonIcon(btn, (icons && icons[key]) || '');
  }
}

function applyWindowTitle(cfg) {
  const title = (cfg.window?.title && String(cfg.window.title).trim()) || 'YouTube + JAV 封面';
  document.title = title;
}

function applySettingsDialogSize(cfg) {
  const d = cfg.settingsDialog || {};
  const w = Math.max(320, parseInt(d.width, 10) || 520);
  const h = Math.max(240, parseInt(d.height, 10) || 640);
  settingsDialog.style.width = `${w}px`;
  settingsDialog.style.height = `${h}px`;
  settingsDialog.style.maxWidth = '95vw';
  settingsDialog.style.maxHeight = '95vh';
}

function fillProxyForm(cfg) {
  const http = cfg.proxy?.http || {};
  const socks5 = cfg.proxy?.socks5 || {};
  $('proxyHttpEnabled').checked = !!http.enabled;
  $('proxyHttpHost').value = http.host || '127.0.0.1';
  $('proxyHttpPort').value = http.port ?? 8080;
  $('proxyHttpUrl').value = http.url || '';
  $('proxySocks5Enabled').checked = !!socks5.enabled;
  $('proxySocks5Host').value = socks5.host || '127.0.0.1';
  $('proxySocks5Port').value = socks5.port ?? 1080;
  $('proxySocks5Url').value = socks5.url || '';
}

function readProxyForm() {
  return {
    http: {
      enabled: $('proxyHttpEnabled').checked,
      host: $('proxyHttpHost').value.trim(),
      port: parseInt($('proxyHttpPort').value, 10) || 8080,
      url: $('proxyHttpUrl').value.trim()
    },
    socks5: {
      enabled: $('proxySocks5Enabled').checked,
      host: $('proxySocks5Host').value.trim(),
      port: parseInt($('proxySocks5Port').value, 10) || 1080,
      url: $('proxySocks5Url').value.trim()
    }
  };
}

function bindExclusiveProxyChecks() {
  const httpCb = $('proxyHttpEnabled');
  const socksCb = $('proxySocks5Enabled');
  httpCb.addEventListener('change', () => {
    if (httpCb.checked) socksCb.checked = false;
  });
  socksCb.addEventListener('change', () => {
    if (socksCb.checked) httpCb.checked = false;
  });
}

function fillSettingsForm(cfg) {
  fillProxyForm(cfg);
  $('showMenuBar').checked = cfg.window?.showMenuBar !== false;
  $('winTitle').value = cfg.window?.title ?? 'YouTube + JAV 封面';
  $('winWidth').value = cfg.window?.width ?? 1200;
  $('winHeight').value = cfg.window?.height ?? 900;
  $('dlgWidth').value = cfg.settingsDialog?.width ?? 520;
  $('dlgHeight').value = cfg.settingsDialog?.height ?? 640;
  $('settingsJsonPath').value = cfg.settingsJsonPath || '';
  const eff = cfg.effectivePaths || {};
  $('settingsJsonPath').placeholder = eff.settingsJsonFile || 'settings.json 完整路径';
  $('javSavePath').value = cfg.javSavePath || '';
  $('javSavePath').placeholder = eff.javSavePath || '封面保存文件夹';
  $('youtubeSavePath').value = cfg.youtubeSavePath || '';
  $('youtubeSavePath').placeholder = eff.youtubeSavePath || '封面保存文件夹';
  $('iconPaste').value = cfg.icons?.paste || '';
  $('iconSearch').value = cfg.icons?.search || '';
  $('iconExtractCode').value = cfg.icons?.extractCode || '';
  $('iconOpenJav').value = cfg.icons?.openJav || '';
  $('iconOpenYoutube').value = cfg.icons?.openYoutube || '';
  $('iconSettings').value = cfg.icons?.settings || '';
  applySettingsDialogSize(cfg);
}

function readSettingsForm() {
  return {
    proxy: readProxyForm(),
    window: {
      title: $('winTitle').value.trim() || 'YouTube + JAV 封面',
      width: parseInt($('winWidth').value, 10) || 1200,
      height: parseInt($('winHeight').value, 10) || 900,
      showMenuBar: $('showMenuBar').checked
    },
    settingsDialog: {
      width: parseInt($('dlgWidth').value, 10) || 520,
      height: parseInt($('dlgHeight').value, 10) || 640
    },
    settingsJsonPath: $('settingsJsonPath').value.trim(),
    javSavePath: $('javSavePath').value.trim(),
    youtubeSavePath: $('youtubeSavePath').value.trim(),
    icons: {
      paste: $('iconPaste').value.trim(),
      search: $('iconSearch').value.trim(),
      extractCode: $('iconExtractCode').value.trim(),
      openJav: $('iconOpenJav').value.trim(),
      openYoutube: $('iconOpenYoutube').value.trim(),
      settings: $('iconSettings').value.trim()
    }
  };
}

function showPreview(result) {
  currentBase64 = result.base64;
  const blob = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([blob], { type: result.mime || 'image/jpeg' }));
  previewImg.onload = () => URL.revokeObjectURL(url);
  previewImg.src = url;
  previewCaption.textContent = `${result.kind === 'youtube' ? 'YouTube' : 'JAV'} · ${result.id} · 已保存: ${result.savedPath}`;
  placeholder.classList.add('hidden');
  previewFigure.classList.remove('hidden');
}

function clearPreview() {
  currentBase64 = null;
  previewImg.removeAttribute('src');
  previewFigure.classList.add('hidden');
  placeholder.classList.remove('hidden');
}

async function doSearch() {
  const text = searchInput.value.trim();
  if (!text) {
    setStatus('请输入链接或代号', true);
    return;
  }
  setStatus('正在加载…');
  try {
    const result = await window.api.searchCover(text);
    showPreview(result);
    setStatus('加载完成');
  } catch (e) {
    clearPreview();
    setStatus(e.message || '加载失败', true);
  }
}

async function init() {
  config = await window.api.getConfig();
  applyWindowTitle(config);
  applyAllIcons(config.icons);
  fillSettingsForm(config);
  bindExclusiveProxyChecks();

  btnPaste.addEventListener('click', async () => {
    const t = await window.api.readClipboardText();
    if (t) searchInput.value = t.trim();
  });

  btnSearch.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  btnExtract.addEventListener('click', async () => {
    const code = await window.api.extractJavCode(searchInput.value);
    if (code) {
      searchInput.value = code;
      setStatus(`已提纯代号: ${code}`);
    } else {
      setStatus('无法提取 JAV 代号', true);
    }
  });

  btnOpenJav.addEventListener('click', () => window.api.openSaveFolder('jav'));
  btnOpenYt.addEventListener('click', () => window.api.openSaveFolder('youtube'));

  btnSettings.addEventListener('click', () => {
    fillSettingsForm(config);
    settingsDialog.showModal();
  });

  ['dlgWidth', 'dlgHeight'].forEach((id) => {
    $(id).addEventListener('input', () => {
      applySettingsDialogSize({
        settingsDialog: {
          width: parseInt($('dlgWidth').value, 10) || 520,
          height: parseInt($('dlgHeight').value, 10) || 640
        }
      });
    });
  });

  $('settingsCancel').addEventListener('click', () => settingsDialog.close());

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    config = await window.api.saveConfig(readSettingsForm());
    applyWindowTitle(config);
    applyAllIcons(config.icons);
    applySettingsDialogSize(config);
    settingsDialog.close();
    setStatus('设置已保存');
  });

  document.querySelectorAll('[data-paste-for]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const inputId = btn.getAttribute('data-paste-for');
      const input = $(inputId);
      if (!input) return;
      const t = await window.api.readClipboardText();
      if (t) input.value = t.trim();
    });
  });

  document.querySelectorAll('[data-open-for]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.api.openSaveFolder(btn.getAttribute('data-open-for'));
    });
  });

  previewImg.addEventListener('contextmenu', (e) => {
    if (!currentBase64) return;
    e.preventDefault();
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.classList.remove('hidden');
  });

  contextMenu.querySelector('[data-action="copy"]').addEventListener('click', async () => {
    if (currentBase64) {
      await window.api.copyImageBuffer(currentBase64);
      setStatus('图片已复制到剪贴板');
    }
    contextMenu.classList.add('hidden');
  });

  document.addEventListener('click', () => contextMenu.classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') contextMenu.classList.add('hidden');
  });
}

if (typeof window.api === 'undefined') {
  document.body.innerHTML = '<p style="padding:24px;color:#fff">请在 Electron 中打开本页面，或运行：<code>electron main.js</code></p>';
} else {
  init();
}
