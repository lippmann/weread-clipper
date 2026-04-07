/**
 * Popup 主逻辑
 */

// ── DOM 引用 ──────────────────────────────────────────────
const loginLink      = document.getElementById('loginLink');
const loginWarning   = document.getElementById('loginWarning');
const stateExtracting   = document.getElementById('stateExtracting');
const stateReady        = document.getElementById('stateReady');
const stateUploading    = document.getElementById('stateUploading');
const stateSuccess      = document.getElementById('stateSuccess');
const stateError        = document.getElementById('stateError');
const stateExtractError = document.getElementById('stateExtractError');

const articleTitle   = document.getElementById('articleTitle');
const articleMeta    = document.getElementById('articleMeta');
const wordCount      = document.getElementById('wordCount');
const uploadingText  = document.getElementById('uploadingText');
const successText    = document.getElementById('successText');
const errorTitle     = document.getElementById('errorTitle');
const errorDetail    = document.getElementById('errorDetail');

const btnSend             = document.getElementById('btnSend');
const btnReset            = document.getElementById('btnReset');
const btnRetry            = document.getElementById('btnRetry');

// 当前提取到的文章数据
let currentArticle = null;
let isLoggedIn = false;

// ── 状态切换 ──────────────────────────────────────────────
const allStates = [stateExtracting, stateReady, stateUploading, stateSuccess, stateError, stateExtractError];

function showState(state) {
  allStates.forEach(s => s.style.display = 'none');
  state.style.display = 'flex';
}

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  // 检查登录状态
  const loginStatus = await chrome.runtime.sendMessage({ action: 'checkLogin' });
  isLoggedIn = loginStatus.loggedIn;

  if (isLoggedIn) {
    loginLink.textContent = '已登录';
    loginLink.className = 'login-link logged-in';
    loginWarning.style.display = 'none';
  } else {
    loginLink.textContent = '未登录';
    loginLink.className = 'login-link';
    loginWarning.style.display = 'block';
  }

  // 提取当前页面文章
  showState(stateExtracting);
  extractArticle();
}

// ── 文章提取 ──────────────────────────────────────────────
async function extractArticle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 先注入 content script（以防没有自动运行）
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
    } catch (e) {
      // 如果已经注入过，忽略错误
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractArticle' });

    if (!response || !response.success) {
      showState(stateExtractError);
      return;
    }

    const article = response.article;

    // 检查内容是否足够
    if (!article.content || article.content.trim().length < 50) {
      showState(stateExtractError);
      return;
    }

    currentArticle = article;
    renderReady(article);
    showState(stateReady);

  } catch (e) {
    showState(stateExtractError);
  }
}

function renderReady(article) {
  articleTitle.value = article.title || '未命名文章';

  const metaParts = [];
  if (article.author) metaParts.push(article.author);
  if (article.siteName) metaParts.push(article.siteName);
  if (article.date) metaParts.push(formatDate(article.date));
  articleMeta.textContent = metaParts.join(' · ');

  const chars = article.content.replace(/\s/g, '').length;
  wordCount.textContent = `约 ${formatCount(chars)} 字`;

  // 没有登录时禁用发送按钮
  if (!isLoggedIn) {
    btnSend.disabled = true;
    btnSend.title = '请先登录微信读书';
  }
}

// ── 发送到微信读书 ────────────────────────────────────────
btnSend.addEventListener('click', async () => {
  if (!currentArticle) return;

  const article = {
    ...currentArticle,
    title: articleTitle.value.trim() || currentArticle.title,
  };

  showState(stateUploading);
  uploadingText.textContent = '正在生成 EPUB…';

  // 稍作延迟让 UI 更新
  await sleep(100);
  uploadingText.textContent = '正在上传到微信读书…';

  const result = await chrome.runtime.sendMessage({
    action: 'uploadToWeread',
    article,
  });

  if (result.success) {
    successText.textContent = `《${article.title}》已成功发送到微信读书！`;
    showState(stateSuccess);
  } else {
    handleUploadError(result, article);
  }
});

function handleUploadError(result, article) {
  if (result.errorCode === 'NOT_LOGGED_IN') {
    errorTitle.textContent = '请先登录微信读书';
    errorDetail.textContent = '需要在微信读书网页版登录后才能上传。';
  } else if (result.errorCode === 'NETWORK_ERROR') {
    errorTitle.textContent = '网络连接失败';
    errorDetail.textContent = result.message || '请检查网络连接后重试。';
  } else if (result.errorCode === 'HTTP_ERROR' && result.status === 401) {
    errorTitle.textContent = '登录已过期';
    errorDetail.textContent = '请重新登录微信读书网页版。';
  } else if (result.errorCode === 'API_ERROR') {
    errorTitle.textContent = '上传接口返回错误';
    errorDetail.textContent = `错误码 ${result.resCode}：${result.message || '未知错误'}`;
  } else {
    errorTitle.textContent = '上传失败';
    errorDetail.textContent = result.message || result.errorCode || '未知错误，请尝试下载后手动上传。';
  }
  showState(stateError);
}


// ── 重置 ──────────────────────────────────────────────────
btnReset.addEventListener('click', () => {
  showState(stateReady);
});

btnRetry.addEventListener('click', () => {
  btnSend.click();
});

// ── 工具函数 ──────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr.split('T')[0];
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return dateStr.split('T')[0];
  }
}

function formatCount(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return n.toString();
}

// ── 启动 ──────────────────────────────────────────────────
init();
