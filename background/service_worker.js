/**
 * Service Worker
 *
 * 上传流程（注入方案）：
 * 1. 生成 EPUB
 * 2. 打开（或复用）weread.qq.com/web/upload 页面
 * 3. 在页面的 MAIN world 注入脚本，模拟文件选择
 * 4. 微信读书自己的 JS 处理 COS 上传、签名、receive 通知——我们无需关心
 */

importScripts('../lib/epub.js');

// ── 登录检查 ──────────────────────────────────────────────
async function checkWereadLogin() {
  const cookies = await chrome.cookies.getAll({ domain: 'weread.qq.com' });
  const skey = cookies.find(c => c.name === 'wr_skey');
  const vid  = cookies.find(c => c.name === 'wr_vid');
  return { loggedIn: !!(skey && vid) };
}

// ── 等待 Tab 加载完成 ─────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── 在 weread 上传页注入文件 ──────────────────────────────
/**
 * 此函数在 weread.qq.com/web/upload 的 MAIN world 中执行。
 * 它将我们的 EPUB 数据注入到页面的 <input type="file"> 中，
 * 触发 change 事件，让页面自己的上传逻辑完全接管。
 */
function injectFileToUploadPage(epubArray, fileName) {
  return new Promise((resolve) => {
    try {
      const file = new File(
        [new Uint8Array(epubArray)],
        fileName,
        { type: 'application/epub+zip' }
      );

      // 找到文件输入框（可能在 React/Vue 组件渲染完成后才出现）
      function tryInject(attempts) {
        const input = document.querySelector('input[type="file"]');
        if (!input) {
          if (attempts > 0) {
            setTimeout(() => tryInject(attempts - 1), 500);
          } else {
            resolve({ ok: false, error: '找不到文件输入框，请确认页面已正常加载' });
          }
          return;
        }

        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;

          // 依次触发 input / change，兼容 React 的合成事件系统
          ['input', 'change'].forEach(evtName => {
            input.dispatchEvent(new Event(evtName, { bubbles: true, cancelable: true }));
          });

          resolve({ ok: true });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      }

      tryInject(10); // 最多重试 10 次，间隔 500ms，共 5s
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ── 图片数据解码 ──────────────────────────────────────────
/**
 * 将 content script 预取的 base64 图片数据转换为 Uint8Array
 * imageData: { [url]: { base64, mimeType, filename } }
 */
function decodeImageData(imageData) {
  if (!imageData || Object.keys(imageData).length === 0) return {};
  const images = {};
  for (const [url, { base64, mimeType, filename }] of Object.entries(imageData)) {
    try {
      const binaryStr = atob(base64);
      const data = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) data[i] = binaryStr.charCodeAt(i);
      images[url] = { data, mimeType, filename };
    } catch { /* 跳过损坏的数据 */ }
  }
  return images;
}

// ── 主上传流程 ────────────────────────────────────────────
async function uploadToWeread(article) {
  // 1. 验证登录
  const loginStatus = await checkWereadLogin();
  if (!loginStatus.loggedIn) {
    return { success: false, errorCode: 'NOT_LOGGED_IN' };
  }

  // 2. 解码图片 + 生成 EPUB
  let epubData;
  try {
    const images = decodeImageData(article.imageData);
    epubData = generateEpub(article, images);
  } catch (e) {
    return { success: false, errorCode: 'EPUB_GENERATION_FAILED', message: e.message };
  }

  const safeName = (article.title || '未命名文章')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80);
  const fileName = `${safeName}.epub`;

  // 3. 找到或打开微信读书上传页
  const uploadUrl = 'https://weread.qq.com/web/upload';
  const existingTabs = await chrome.tabs.query({ url: 'https://weread.qq.com/*' });

  let tabId;
  if (existingTabs.length > 0) {
    tabId = existingTabs[0].id;
    // 如果已在上传页则直接使用，否则导航过去
    if (!existingTabs[0].url?.includes('/web/upload')) {
      await chrome.tabs.update(tabId, { url: uploadUrl });
      await waitForTabLoad(tabId);
    }
  } else {
    const tab = await chrome.tabs.create({ url: uploadUrl, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
  }

  // 4. 等待 JS 框架初始化（React/Vue 需要时间渲染）
  await new Promise(r => setTimeout(r, 1500));

  // 5. 在 MAIN world 注入文件
  //    注意：Uint8Array 需要先转为普通 Array 才能通过 args 传递
  const epubArray = Array.from(epubData);

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectFileToUploadPage,
      args: [epubArray, fileName],
    });
  } catch (e) {
    return { success: false, errorCode: 'INJECT_FAILED', message: e.message };
  }

  const result = results?.[0]?.result;
  if (!result?.ok) {
    return {
      success: false,
      errorCode: 'UPLOAD_PAGE_ERROR',
      message: result?.error || '注入失败，请确认已登录并打开过微信读书',
    };
  }

  // 6. 把上传页切换到前台，让用户看到上传进度
  await chrome.tabs.update(tabId, { active: true });

  return { success: true };
}

// ── 下载 EPUB（备用方案）────────────────────────────────
async function downloadEpub(article) {
  const images = decodeImageData(article.imageData);
  const epubData = generateEpub(article, images);
  const safeName = (article.title || '未命名文章')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80);

  const blob = new Blob([epubData], { type: 'application/epub+zip' });
  const url = URL.createObjectURL(blob);
  const downloadId = await chrome.downloads.download({
    url,
    filename: `${safeName}.epub`,
    saveAs: false,
  });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { success: true, downloadId };
}

// ── 消息监听 ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkLogin') {
    checkWereadLogin().then(sendResponse);
    return true;
  }
  if (message.action === 'uploadToWeread') {
    uploadToWeread(message.article)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, errorCode: 'UPLOAD_FAILED', message: e.message }));
    return true;
  }
  if (message.action === 'downloadEpub') {
    downloadEpub(message.article)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, errorCode: 'DOWNLOAD_FAILED', message: e.message }));
    return true;
  }
});
