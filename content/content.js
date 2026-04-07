/**
 * Content script: 提取当前页面的文章内容
 * 使用多策略方法，适配新浪、网易、腾讯、澎湃等主流中文新闻网站
 */

(function () {
  // 防止重复注入
  if (window.__wereadClipperInjected) return;
  window.__wereadClipperInjected = true;

  /**
   * 从 meta 标签或 JSON-LD 提取文章元信息
   */
  function extractMeta() {
    const meta = {
      title: '',
      author: '',
      date: '',
      siteName: '',
      description: '',
      url: window.location.href,
    };

    // 标题
    meta.title =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content ||
      document.title ||
      '';

    // 作者
    meta.author =
      document.querySelector('meta[name="author"]')?.content ||
      document.querySelector('meta[property="article:author"]')?.content ||
      document.querySelector('[rel="author"]')?.textContent?.trim() ||
      '';

    // 发布日期
    meta.date =
      document.querySelector('meta[property="article:published_time"]')?.content ||
      document.querySelector('meta[name="publishdate"]')?.content ||
      document.querySelector('time[datetime]')?.getAttribute('datetime') ||
      '';

    // 站点名称
    meta.siteName =
      document.querySelector('meta[property="og:site_name"]')?.content ||
      document.querySelector('meta[name="application-name"]')?.content ||
      window.location.hostname ||
      '';

    // 尝试从 JSON-LD 补充
    try {
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        const data = JSON.parse(script.textContent);
        const article = Array.isArray(data) ? data.find(d => d['@type'] === 'NewsArticle' || d['@type'] === 'Article') : data;
        if (article) {
          if (!meta.title && article.headline) meta.title = article.headline;
          if (!meta.author && article.author) {
            meta.author = Array.isArray(article.author)
              ? article.author.map(a => a.name || a).join('、')
              : article.author.name || article.author;
          }
          if (!meta.date && article.datePublished) meta.date = article.datePublished;
          break;
        }
      }
    } catch (e) {}

    return meta;
  }

  /**
   * 评估一个元素的"文章内容"得分
   */
  function scoreElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
    const tag = el.tagName.toLowerCase();
    const id = (el.id || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();

    // 直接排除
    const noisePatterns = /nav|footer|header|sidebar|comment|widget|menu|ad|banner|share|related|recommend|hot|popup|modal|cookie|social|search|pagination/i;
    if (noisePatterns.test(id) || noisePatterns.test(cls)) return -100;

    let score = 0;

    // 有利标签
    if (tag === 'article') score += 30;
    if (tag === 'main') score += 20;
    if (tag === 'section') score += 5;
    if (tag === 'div') score += 0;

    // 有利 class/id 关键词
    const goodPatterns = /article|content|post|body|text|story|detail|main|entry|page/i;
    if (goodPatterns.test(id)) score += 25;
    if (goodPatterns.test(cls)) score += 15;

    // 中文新闻网站特有选择器
    const cnPatterns = /artical|artBody|artContent|newstext|article_content|detail_content|post_body|TRS_Editor/i;
    if (cnPatterns.test(id) || cnPatterns.test(cls)) score += 30;

    // 根据文本密度打分
    const text = el.innerText || '';
    const textLength = text.trim().length;
    const linkText = Array.from(el.querySelectorAll('a')).reduce((s, a) => s + (a.innerText || '').length, 0);
    const linkDensity = textLength > 0 ? linkText / textLength : 1;

    if (textLength > 500) score += 20;
    if (textLength > 1000) score += 20;
    if (textLength > 2000) score += 10;
    if (linkDensity < 0.2) score += 10;
    if (linkDensity > 0.5) score -= 20;

    // 段落数量
    const pCount = el.querySelectorAll('p').length;
    score += Math.min(pCount * 3, 30);

    return score;
  }

  /**
   * 主要内容提取
   */
  function extractContent() {
    // 策略 1: 常用选择器（优先精确匹配）
    const directSelectors = [
      // 标准语义标签
      'article',
      'main article',
      '[role="article"]',
      '[role="main"]',

      // 中文新闻网站
      '#artBody', '#article_content', '#article-content',
      '#artText', '#newscontent', '#news_txt',
      '.article_content', '.artical-content', '.article-body',
      '.detail-content', '.detail_content', '.post-content',
      '.news-text', '.newstext', '.article-wrap',
      '.TRS_Editor', '.article_bd', '.art_content',
      '.main-text', '.article_detail', '.text-content',
      '.entry-content', '.post-body', '.article__body',

      // 澎湃、36kr、虎嗅等
      '.index_articleContent', '.article-detail',
      '.content-article', '.article-inner',
    ];

    let best = null;
    let bestScore = 0;

    for (const selector of directSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const score = scoreElement(el);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
        if (score > 50) break; // 足够好就不再继续
      }
    }

    // 策略 2: 遍历 div/section/article 找最高分
    if (!best || bestScore < 30) {
      const candidates = document.querySelectorAll('div, section, article');
      for (const el of candidates) {
        // 跳过嵌套太深的元素（可能是子容器）
        if (el.querySelectorAll('div, section, article').length > 20) continue;
        const score = scoreElement(el);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }

    // 策略 3: 实在找不到就用 body
    if (!best) best = document.body;

    return cleanContent(best);
  }

  /**
   * 清理提取到的内容，移除噪音节点
   * 返回 { text, htmlContent, imageUrls }
   */
  function cleanContent(el) {
    const clone = el.cloneNode(true);

    // 移除脚本、样式、广告等噪音
    const removeSelectors = [
      'script', 'style', 'iframe', 'noscript', 'button',
      'nav', 'footer', 'header', 'aside', 'form',
      '.ad', '.ads', '.advertisement', '.share', '.social',
      '.comment', '.comments', '.related', '.recommend',
      '.hot-news', '.pagination', '.copyright',
      '[class*="share"]', '[class*="social"]', '[class*="comment"]',
      '[class*="related"]', '[id*="comment"]', '[id*="share"]',
    ];

    for (const sel of removeSelectors) {
      clone.querySelectorAll(sel).forEach(n => n.remove());
    }

    // 处理图片：保留绝对 URL，清理多余属性
    // 优先使用 data-src（懒加载真实 URL），其次使用 img.src
    const imageUrls = [];
    clone.querySelectorAll('img').forEach(img => {
      // 常见懒加载属性（data-src 存在即代表它是真实 URL）
      const lazySrc =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-lazy') ||
        img.getAttribute('data-img') ||
        img.getAttribute('data-actualsrc') ||
        img.getAttribute('data-lazy-src');

      let src;
      if (lazySrc && lazySrc.startsWith('http')) {
        // data-src 存在且是绝对 URL → 直接用，不管 src 是什么
        src = lazySrc;
      } else {
        src = img.src || '';
        // 过滤掉明显的占位符
        if (
          !src.startsWith('http') ||
          src.startsWith('data:') ||
          src === window.location.href ||
          (img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2)
        ) {
          // 尝试用 lazySrc 补救
          if (lazySrc) {
            try { src = new URL(lazySrc, window.location.href).href; } catch { src = lazySrc; }
          } else {
            img.remove();
            return;
          }
        }
      }

      if (!src || !src.startsWith('http')) { img.remove(); return; }
      imageUrls.push(src);
      const alt = img.alt || '';
      [...img.attributes].forEach(attr => img.removeAttribute(attr.name));
      img.setAttribute('src', src);
      if (alt) img.setAttribute('alt', alt);
    });

    // 将 <br> 转为换行符（仅用于纯文本提取）
    const cloneForText = clone.cloneNode(true);
    cloneForText.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

    return {
      htmlContent: clone.innerHTML,
      text: extractText(cloneForText),
      imageUrls: [...new Set(imageUrls)],
    };
  }

  /**
   * 将 DOM 结构转为格式化纯文本
   */
  function extractText(el) {
    const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'div', 'section', 'article', 'tr']);
    let result = '';

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();
      const isBlock = blockTags.has(tag);

      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        result += '\n\n';
      } else if (isBlock) {
        result += '\n';
      }

      for (const child of node.childNodes) {
        walk(child);
      }

      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        result += '\n';
      } else if (isBlock) {
        result += '\n';
      }
    }

    walk(el);

    // 清理多余空行
    return result
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 在页面上下文中抓取图片并转为 base64
   * 在 content script 里执行，请求自动携带当前页面的 Referer，
   * 可绕过 BBC、网易等 CDN 的防盗链限制。
   * 返回 { [url]: { base64, mimeType, filename } }
   */
  async function fetchImagesInPage(imageUrls) {
    if (!imageUrls || imageUrls.length === 0) return {};
    const extMap = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg',
      'image/png': 'png', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/svg+xml': 'svg',
    };

    const results = await Promise.all(
      imageUrls.map(async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'omit' });
          if (!resp.ok) return null;
          const blob = await resp.blob();
          if (!blob.type.startsWith('image/')) return null;

          // Uint8Array → base64（分块处理，防止大图堆栈溢出）
          const buf = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < buf.length; i += chunk) {
            binary += String.fromCharCode(...buf.subarray(i, i + chunk));
          }
          return { url, base64: btoa(binary), mimeType: blob.type };
        } catch {
          return null;
        }
      })
    );

    const imageData = {};
    results.filter(Boolean).forEach((r, i) => {
      const ext = extMap[r.mimeType] || 'jpg';
      imageData[r.url] = {
        base64: r.base64,
        mimeType: r.mimeType,
        filename: `img${String(i).padStart(3, '0')}.${ext}`,
      };
    });
    return imageData;
  }

  // 监听来自 popup 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractArticle') {
      // 异步：先提取内容，再在页面上下文里抓图
      (async () => {
        try {
          const meta = extractMeta();
          const extracted = extractContent();
          const imageData = await fetchImagesInPage(extracted.imageUrls);
          sendResponse({
            success: true,
            article: {
              title: meta.title,
              author: meta.author,
              date: meta.date,
              siteName: meta.siteName,
              url: meta.url,
              content: extracted.text,
              htmlContent: extracted.htmlContent,
              imageUrls: extracted.imageUrls,
              imageData, // 已在页面上下文预取的图片数据
            },
          });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
    }
    return true; // 保持消息通道开启（异步必须）
  });
})();
