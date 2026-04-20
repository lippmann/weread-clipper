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
   * 使用 textContent 而非 innerText，兼容 DOMParser 创建的离线文档
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

    // 根据文本密度打分（textContent 在离线文档中同样可用）
    const text = el.textContent || '';
    const textLength = text.trim().length;
    const linkText = Array.from(el.querySelectorAll('a')).reduce((s, a) => s + (a.textContent || '').length, 0);
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
   * @param {Document} doc - 目标文档，默认为当前页面的 document
   */
  function extractContent(doc = document) {
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
      const el = doc.querySelector(selector);
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
      const candidates = doc.querySelectorAll('div, section, article');
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
    if (!best) best = doc.body;

    return cleanContent(best, doc === document ? window.location.href : '');
  }

  /**
   * 清理提取到的内容，移除噪音节点
   * 返回 { text, htmlContent, imageUrls }
   * @param {Element} el - 要清理的元素
   * @param {string} baseUrl - 用于解析相对 URL（对 DOMParser 文档尤其重要）
   */
  function cleanContent(el, baseUrl = window.location.href) {
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
        // 优先尝试 img.src（活跃文档中已是绝对 URL）
        // 对 DOMParser 文档兜底：用 getAttribute('src') + baseUrl 解析
        src = img.src || '';
        if (!src.startsWith('http')) {
          const attrSrc = img.getAttribute('src') || '';
          if (attrSrc) {
            try { src = new URL(attrSrc, baseUrl).href; } catch { src = ''; }
          }
        }

        // 过滤掉明显的占位符
        if (
          !src.startsWith('http') ||
          src.startsWith('data:') ||
          src === baseUrl ||
          (img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2)
        ) {
          // 尝试用 lazySrc 补救
          if (lazySrc) {
            try { src = new URL(lazySrc, baseUrl).href; } catch { src = lazySrc; }
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

    // 二次过滤：只保留真正的正文块，去掉推荐、版权、作者简介等杂项
    const cleaned = extractMeaningfulBlocks(clone);

    // 将 <br> 转为换行符（仅用于纯文本提取）
    const cloneForText = cleaned.cloneNode(true);
    cloneForText.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

    return {
      htmlContent: cleaned.innerHTML,
      text: extractText(cloneForText),
      imageUrls: [...new Set(imageUrls)],
    };
  }

  /**
   * 从已清理的容器中提取有意义的正文块，过滤掉导航、推荐、版权等噪音。
   *
   * 策略：
   * - 直接保留语义内容标签（p / h1-h6 / blockquote / figure）
   * - 图片直接保留
   * - 列表：仅保留条目平均长度 > 15 字的（排除导航菜单）
   * - div/section：无块级子节点且文本量 > 40 字时视为段落；否则递归
   * - 链接密度 > 65% 的节点跳过（导航、相关阅读等）
   */
  function extractMeaningfulBlocks(el) {
    const out = document.createElement('div');
    const CONTENT = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption']);
    const LISTS   = new Set(['ul', 'ol']);
    const BLOCK   = new Set(['div', 'section', 'article', 'main', 'td', 'dd']);

    function linkDensity(node) {
      const total = (node.textContent || '').trim().length;
      if (!total) return 0;
      const linked = Array.from(node.querySelectorAll('a'))
        .reduce((s, a) => s + (a.textContent || '').length, 0);
      return linked / total;
    }

    function visit(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      const text = (node.textContent || '').trim();

      // 高链接密度（导航 / 相关推荐）且无图片 → 跳过
      if (linkDensity(node) > 0.65 && !node.querySelector('img')) return;

      // 直接内容标签
      if (CONTENT.has(tag)) {
        if (text.length > 10 || node.querySelector('img')) {
          out.appendChild(node.cloneNode(true));
        }
        return;
      }

      // 图片
      if (tag === 'img') {
        out.appendChild(node.cloneNode(true));
        return;
      }

      // 列表：过滤掉项目过多或平均文字太少的（导航菜单特征）
      if (LISTS.has(tag)) {
        const items = node.querySelectorAll('li');
        const avgLen = items.length ? text.length / items.length : 0;
        if (items.length >= 1 && items.length <= 25 && avgLen > 15) {
          out.appendChild(node.cloneNode(true));
        }
        return;
      }

      // 块级容器：判断是否是"叶子段落"还是需要递归
      if (BLOCK.has(tag)) {
        const hasBlockKids = [...node.children].some(c => {
          const t = c.tagName.toLowerCase();
          return CONTENT.has(t) || LISTS.has(t) || BLOCK.has(t);
        });
        // 没有块级子节点、文字够多 → 当作段落处理
        if (!hasBlockKids && text.length > 40) {
          const p = document.createElement('p');
          p.innerHTML = node.innerHTML;
          out.appendChild(p);
          return;
        }
        // 有块级子节点 → 递归
        for (const child of node.childNodes) visit(child);
        return;
      }

      // 其他标签递归
      for (const child of node.childNodes) visit(child);
    }

    for (const child of el.childNodes) visit(child);
    return out;
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

  // ── 站点专属提取器 ──────────────────────────────────────

  /**
   * 维基百科专属提取器
   * 直接选取 .mw-parser-output 下的语义块，跳过链接密度过滤
   * （维基正文段落含大量词条链接，通用规则会误判为导航噪音）
   */
  function extractWikipedia(doc = document, baseUrl = window.location.href) {
    const container = doc.querySelector('.mw-parser-output') ||
                      doc.querySelector('#mw-content-text');
    if (!container) return extractContent(doc);

    const clone = container.cloneNode(true);

    // 移除维基百科特有噪音：目录、导航框、引用列表、编辑按钮等
    [
      '#toc', '.toc', '.navbox', '[class*="navbox"]',
      '.mw-editsection', '.reflist', '.references',
      '.hatnote', '.sidebar', '[role="navigation"]',
      '.mw-empty-elt', '.metadata', 'sup.reference',
      'table',  // 移除信息框（infobox）和 wikitable，在 EPUB 中排版复杂
    ].forEach(sel => clone.querySelectorAll(sel).forEach(n => n.remove()));

    const out = document.createElement('div');
    const imageUrls = [];

    // 直接收集段落、标题、引用、图片块——不经过链接密度过滤
    clone.querySelectorAll('p, h2, h3, h4, h5, h6, blockquote, figure, div.thumb').forEach(el => {
      const text = el.textContent.trim();
      if (!text && !el.querySelector('img')) return;
      if (text.length < 5 && !el.querySelector('img')) return;

      // 收集图片 URL（处理 // 协议相对路径）
      el.querySelectorAll('img').forEach(img => {
        const raw = img.getAttribute('data-src') || img.getAttribute('src') || '';
        let src = raw;
        if (src.startsWith('//')) src = 'https:' + src;
        else if (src && !src.startsWith('http')) {
          try { src = new URL(src, baseUrl).href; } catch { src = ''; }
        }
        if (src) imageUrls.push(src);
      });

      out.appendChild(el.cloneNode(true));
    });

    if (out.textContent.trim().length < 50) return extractContent(doc);

    const cloneForText = out.cloneNode(true);
    cloneForText.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

    return {
      htmlContent: out.innerHTML,
      text: extractText(cloneForText),
      imageUrls: [...new Set(imageUrls)],
    };
  }

  /**
   * 百度百科专属提取器
   * 百度百科正文用嵌套 div + span 而非 <p>，通用递归逻辑无法提取叶子文本
   * 此处直接定位 .J-lemma-content，逐层找"叶子块"转为段落
   */
  function extractBaiduBaike(doc = document, baseUrl = window.location.href) {
    const container = doc.querySelector('.J-lemma-content') ||
                      doc.querySelector('#J-lemma-main-wrapper');
    if (!container) return extractContent(doc);

    const clone = container.cloneNode(true);

    // 移除编辑按钮、引用上标、目录等噪音
    [
      'script', 'style', 'sup',
      '[class*="edit"]', '[class*="Edit"]',
      '[class*="catalog"]', '[class*="Catalog"]',
      '[class*="reference"]',
    ].forEach(sel => clone.querySelectorAll(sel).forEach(n => n.remove()));

    const out = document.createElement('div');
    const imageUrls = [];

    // 判断是否为"叶子块"：子节点全是内联元素（span/a/em 等），无 div/p 等块元素
    const INLINE_TAGS = new Set(['span', 'a', 'em', 'strong', 'b', 'i', 'br', 'code', 'img']);

    function visit(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const cls = typeof node.className === 'string' ? node.className : '';
      const text = node.textContent.trim();

      // 段落标题（class 里含 title 但不是大容器）
      if (/title/i.test(cls) && !/(?:content|wrapper|box|main|lemma)/i.test(cls)) {
        if (text.length > 0 && text.length < 120) {
          const h = document.createElement('h3');
          h.textContent = text;
          out.appendChild(h);
          return;
        }
      }

      // 叶子块：子节点均为内联元素 → 直接作为段落
      const hasBlockKids = [...node.children].some(c => !INLINE_TAGS.has(c.tagName.toLowerCase()));
      if (!hasBlockKids) {
        if (text.length > 15) {
          // 收集图片
          node.querySelectorAll('img').forEach(img => {
            const raw = img.getAttribute('src') || '';
            const src = raw.startsWith('http') ? raw :
                        (raw ? (() => { try { return new URL(raw, baseUrl).href; } catch { return ''; } })() : '');
            if (src) imageUrls.push(src);
          });
          const p = document.createElement('p');
          p.innerHTML = node.innerHTML;
          out.appendChild(p);
        }
        return;
      }

      // 有块级子节点 → 递归
      for (const child of node.children) visit(child);
    }

    for (const child of clone.children) visit(child);

    // 提取失败时降级到通用逻辑
    if (out.textContent.trim().length < 50) return extractContent(doc);

    const cloneForText = out.cloneNode(true);
    cloneForText.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

    return {
      htmlContent: out.innerHTML,
      text: extractText(cloneForText),
      imageUrls: [...new Set(imageUrls)],
    };
  }

  /**
   * 根据 URL 调度到对应提取器（站点专属或通用）
   */
  function extractForUrl(doc = document, url = window.location.href) {
    try {
      const { hostname } = new URL(url);
      if (/wikipedia\.org$/.test(hostname)) return extractWikipedia(doc, url);
      if (/baike\.baidu\.com$/.test(hostname)) return extractBaiduBaike(doc, url);
    } catch {}
    return extractContent(doc);
  }

  /**
   * 检测文档中是否有"下一页"链接
   * 支持 <link rel="next">、<a rel="next">，以及含分页参数的"次へ"等文字链接
   * @param {Document} doc
   * @param {string} baseUrl - 用于解析相对 href
   * @returns {string|null} 下一页的绝对 URL，或 null
   */
  function detectNextPageUrl(doc, baseUrl) {
    function resolve(href) {
      if (!href || href === '#') return null;
      if (href.startsWith('http')) return href;
      try { return new URL(href, baseUrl).href; } catch { return null; }
    }

    // 1. <link rel="next"> —— 最可靠（Yahoo News、Bloomberg 等使用）
    const linkNext = doc.querySelector('link[rel="next"]');
    if (linkNext) {
      const url = resolve(linkNext.getAttribute('href'));
      if (url) return url;
    }

    // 2. <a rel="next">
    const aNext = doc.querySelector('a[rel="next"]');
    if (aNext) {
      const url = resolve(aNext.getAttribute('href'));
      if (url) return url;
    }

    // 3. 文字匹配 + URL 含分页参数
    //    只认定含明确分页参数的链接（避免把"下一篇文章"误识别为翻页）
    const nextTexts = ['次のページ', '次へ', '次ページ', 'Next', '下一页', '下一頁'];
    const pagePattern = /[?&]p(?:age)?=\d+|\/page\/\d+/i;

    for (const a of doc.querySelectorAll('a[href]')) {
      const text = (a.textContent || '').trim().replace(/[\s\u3000]+/g, '');
      if (!nextTexts.some(t => text === t || text.startsWith(t))) continue;

      const url = resolve(a.getAttribute('href'));
      if (!url) continue;

      if (pagePattern.test(url)) return url;

      // 兜底：和当前页同域同路径，仅 query 不同（如 Yahoo Japan 的 ?page=N）
      try {
        const base = new URL(baseUrl);
        const next = new URL(url);
        if (base.hostname === next.hostname && base.pathname === next.pathname && url !== baseUrl) {
          return url;
        }
      } catch {}
    }

    return null;
  }

  /**
   * 抓取指定 URL 的页面并提取正文内容
   * 使用 DOMParser 在页面上下文内解析，自动携带 Cookie（支持登录墙）
   * @param {string} url
   * @returns {{ htmlContent, text, imageUrls, nextUrl }|null}
   */
  async function fetchAndExtractPage(url) {
    let resp;
    try {
      resp = await fetch(url, { credentials: 'include' });
    } catch {
      return null;
    }
    if (!resp.ok) return null;

    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 设置 <base> 确保 img.src 等相对 URL 能正确解析
    let base = doc.querySelector('base');
    if (base) {
      const existing = base.getAttribute('href') || '';
      if (!existing.startsWith('http')) base.setAttribute('href', url);
    } else {
      base = doc.createElement('base');
      base.setAttribute('href', url);
      doc.head.insertBefore(base, doc.head.firstChild);
    }

    const extracted = extractForUrl(doc, url);
    const nextUrl = detectNextPageUrl(doc, url);
    return { ...extracted, nextUrl };
  }

  /**
   * 收集当前文章所有分页的内容
   * 如果无分页则直接返回单页内容；否则依次抓取后续各页并合并
   */
  async function collectAllPages() {
    const meta = extractMeta();
    const page1 = extractForUrl(document, window.location.href);
    const nextUrl1 = detectNextPageUrl(document, window.location.href);

    if (!nextUrl1) {
      return { meta, extracted: page1, pageCount: 1 };
    }

    // 有分页：依次抓取所有后续页（最多 10 页防止死循环）
    const pages = [page1];
    let nextUrl = nextUrl1;
    const MAX_PAGES = 10;

    while (nextUrl && pages.length < MAX_PAGES) {
      const page = await fetchAndExtractPage(nextUrl);
      if (!page) break;
      pages.push(page);
      nextUrl = page.nextUrl;
    }

    // 合并内容：多页时用 <hr> 分隔
    const allHtml = pages.length === 1
      ? pages[0].htmlContent
      : pages.map((p, i) => `<div data-page="${i + 1}">${p.htmlContent}</div>`).join('\n<hr/>\n');

    const allText = pages.map(p => p.text).join('\n\n');
    const allImageUrls = [...new Set(pages.flatMap(p => p.imageUrls))];

    return {
      meta,
      extracted: { text: allText, htmlContent: allHtml, imageUrls: allImageUrls },
      pageCount: pages.length,
    };
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
      // 异步：收集所有分页内容，再在页面上下文里抓图
      (async () => {
        try {
          const { meta, extracted, pageCount } = await collectAllPages();
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
              imageData,
              pageCount,
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
