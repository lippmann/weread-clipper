/**
 * 轻量级 EPUB 生成器（无外部依赖）
 * 生成符合 EPUB 2.0 规范的文件
 *
 * 原理：EPUB 本质上是一个 ZIP 文件
 * 这里使用纯 JavaScript 实现最简 ZIP 构建（Store 模式，无压缩）
 */

// ============================================================
// 极简 ZIP 构建器（Store 模式）
// ============================================================
class ZipBuilder {
  constructor() {
    this.files = [];
  }

  addFile(name, content, compress = false) {
    const encoder = new TextEncoder();
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    this.files.push({ name, data, compress: false }); // Store 模式，不压缩
  }

  _crc32(data) {
    const table = ZipBuilder._crcTable || (ZipBuilder._crcTable = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })());
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  _uint16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  _uint32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

  build() {
    const encoder = new TextEncoder();
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const file of this.files) {
      const nameBytes = encoder.encode(file.name);
      const crc = this._crc32(file.data);
      const size = file.data.length;

      // Local file header
      const localHeader = [
        0x50, 0x4b, 0x03, 0x04,        // signature
        0x14, 0x00,                      // version needed
        0x00, 0x00,                      // flags
        0x00, 0x00,                      // compression: stored
        0x00, 0x00,                      // mod time
        0x00, 0x00,                      // mod date
        ...this._uint32(crc),
        ...this._uint32(size),
        ...this._uint32(size),
        ...this._uint16(nameBytes.length),
        0x00, 0x00,                      // extra field length
        ...nameBytes,
      ];

      // Central directory entry
      centralDir.push([
        0x50, 0x4b, 0x01, 0x02,        // signature
        0x14, 0x00,                      // version made by
        0x14, 0x00,                      // version needed
        0x00, 0x00,                      // flags
        0x00, 0x00,                      // compression
        0x00, 0x00,                      // mod time
        0x00, 0x00,                      // mod date
        ...this._uint32(crc),
        ...this._uint32(size),
        ...this._uint32(size),
        ...this._uint16(nameBytes.length),
        0x00, 0x00,                      // extra field length
        0x00, 0x00,                      // comment length
        0x00, 0x00,                      // disk number start
        0x00, 0x00,                      // internal attributes
        0x00, 0x00, 0x00, 0x00,          // external attributes
        ...this._uint32(offset),
        ...nameBytes,
      ]);

      offset += localHeader.length + size;
      parts.push(new Uint8Array(localHeader), file.data);
    }

    const centralDirFlat = centralDir.flat();
    const centralDirSize = centralDirFlat.length;
    const centralDirOffset = offset;

    // End of central directory
    const eocd = [
      0x50, 0x4b, 0x05, 0x06,
      0x00, 0x00,
      0x00, 0x00,
      ...this._uint16(this.files.length),
      ...this._uint16(this.files.length),
      ...this._uint32(centralDirSize),
      ...this._uint32(centralDirOffset),
      0x00, 0x00,
    ];

    parts.push(new Uint8Array(centralDirFlat), new Uint8Array(eocd));

    // 合并所有部分
    const totalSize = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }
    return result;
  }
}

// ============================================================
// EPUB 生成
// ============================================================

/**
 * 将文章对象生成为 EPUB 二进制数据
 * @param {Object} article - { title, author, siteName, date, url, content, htmlContent, imageUrls }
 * @param {Object} images  - { [url]: { data: Uint8Array, mimeType: string, filename: string } }
 * @returns {Uint8Array}
 */
function generateEpub(article, images = {}) {
  const { title, author, siteName, date, url, content, htmlContent } = article;
  const bookId = `weread-clip-${Date.now()}`;
  const safeTitle = escapeXml(title || '未命名文章');
  const safeAuthor = escapeXml(author || siteName || '未知作者');
  const safeDate = date ? date.split('T')[0] : new Date().toISOString().split('T')[0];

  const zip = new ZipBuilder();

  // 1. mimetype（必须第一个，且不压缩）
  zip.addFile('mimetype', 'application/epub+zip');

  // 2. META-INF/container.xml
  zip.addFile('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:schemas:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // 3. 图片清单条目 & 写入 zip
  const imageEntries = Object.values(images);
  const imageManifestItems = imageEntries
    .map((img, i) => `    <item id="img${i}" href="images/${img.filename}" media-type="${img.mimeType}"/>`)
    .join('\n');
  for (const img of imageEntries) {
    zip.addFile(`OEBPS/images/${img.filename}`, img.data);
  }

  // 4. OEBPS/content.opf（包信息）
  zip.addFile('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">${bookId}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>
    <dc:creator>${safeAuthor}</dc:creator>
    <dc:date>${safeDate}</dc:date>
    <dc:language>zh-CN</dc:language>
    <dc:source>${escapeXml(url || '')}</dc:source>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${imageManifestItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`);

  // 5. OEBPS/toc.ncx（目录）
  zip.addFile('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${safeTitle}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>${safeTitle}</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`);

  // 6. OEBPS/style.css
  zip.addFile('OEBPS/style.css', `
body {
  font-family: "PingFang SC", "Microsoft YaHei", "Noto Serif CJK SC", serif;
  font-size: 1em;
  line-height: 1.8;
  color: #333;
  margin: 1em 2em;
}
h1 { font-size: 1.4em; margin-bottom: 0.3em; }
.meta { color: #888; font-size: 0.85em; margin-bottom: 1.5em; }
.source-url { word-break: break-all; }
p { margin: 0.5em 0; text-indent: 2em; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #666; }
`);

  // 7. OEBPS/chapter1.xhtml（正文）
  // 优先使用 HTML 版本（含图片），回退到纯文本转换
  const chapterBody = htmlContent
    ? buildHtmlChapter(htmlContent, images)
    : contentToHtml(content);

  zip.addFile('OEBPS/chapter1.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>
  <title>${safeTitle}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>${safeTitle}</h1>
  <div class="meta">
    <span>作者：${safeAuthor}</span> &#160;·&#160;
    <span>来源：${escapeXml(siteName || '')}</span> &#160;·&#160;
    <span>日期：${safeDate}</span><br/>
    <span class="source-url">链接：${escapeXml(url || '')}</span>
  </div>
  <hr/>
  ${chapterBody}
</body>
</html>`);

  return zip.build();
}

/**
 * 将提取的 HTML 内容转为 EPUB 正文
 * - 将远程图片 URL 替换为本地路径（images/imgXXX.ext）
 * - 对未能下载的图片，显示 alt 说明文字
 * - 修复 XHTML 的自闭合标签
 */
function buildHtmlChapter(html, images) {
  let result = html;

  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 替换已下载的图片 URL 为本地路径
  // 注意：innerHTML 序列化时会把 URL 中的 & 编码为 &amp;，需同时替换两种形式
  for (const [remoteUrl, img] of Object.entries(images)) {
    const local = `images/${img.filename}`;

    // 形式 1：原始 URL（直接出现在属性值中）
    result = result.replace(new RegExp(escapeRegex(remoteUrl), 'g'), local);

    // 形式 2：HTML 编码后的 URL（innerHTML 序列化产物，& → &amp;）
    const htmlEncoded = remoteUrl.replace(/&/g, '&amp;');
    if (htmlEncoded !== remoteUrl) {
      result = result.replace(new RegExp(escapeRegex(htmlEncoded), 'g'), local);
    }
  }

  // 未能下载的图片（src 仍是 http 开头）：替换为说明文字
  result = result.replace(
    /<img[^>]*src="(https?:[^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
    (_, _src, alt) => alt ? `<p>[图片: ${escapeXml(alt)}]</p>` : ''
  );
  result = result.replace(/<img[^>]*src="(https?:[^"]*)"[^>]*\/?>/gi, '');

  // XHTML 修复：img/br/hr 必须自闭合
  result = result.replace(/<(img|br|hr)(\s[^>]*)?\s*(?!\/)>/gi, '<$1$2/>');

  // 移除可能残留的 script/style
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');

  return result;
}

/**
 * 将纯文本内容转为 HTML 段落
 */
function contentToHtml(text) {
  if (!text) return '<p>（内容为空）</p>';
  return text
    .split('\n\n')
    .map(para => para.trim())
    .filter(para => para.length > 0)
    .map(para => {
      const escaped = escapeXml(para.replace(/\n/g, ' '));
      return `<p>${escaped}</p>`;
    })
    .join('\n');
}

function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 导出给 service worker 使用
if (typeof module !== 'undefined') {
  module.exports = { generateEpub };
}
