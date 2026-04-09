# Privacy Policy — 剪阅：一键上传微信读书

*Last updated: 2026-04-09*

---

## Overview

剪阅 (Jian Yue) is a Chrome extension that extracts article content from webpages and sends it to WeChat Reading (微信读书) as an EPUB file. We are committed to protecting your privacy. This policy explains what data the extension accesses and how it is used.

---

## Data Collection

**We do not collect, store, or transmit any personal data.**

The extension does not:
- Record your browsing history
- Send any information to our servers (we have no servers)
- Track your usage or behavior
- Share any data with third parties

---

## Data Access and Use

The extension accesses the following data solely to provide its core functionality:

| Data | Purpose |
|------|---------|
| Content of the active tab | Extract article text and images from the webpage you are currently viewing |
| Images on the page | Fetched in the page context (with Referer header) to include them in the generated EPUB file |
| weread.qq.com cookies | Read locally to verify that you are logged into WeChat Reading before attempting an upload. Cookie values are never stored or transmitted outside your browser. |

All processing happens **locally in your browser**. The generated EPUB file is passed directly to the official WeChat Reading upload page — no intermediate server is involved.

---

## Permissions

The extension requests the following Chrome permissions, each used strictly for the stated purpose:

- **activeTab** — Access the current tab to extract article content
- **tabs** — Find or open the WeChat Reading upload tab
- **scripting** — Inject the content script and trigger the upload flow
- **cookies** — Check WeChat Reading login status
- **host permissions (`<all_urls>`)** — Fetch images from any site in the page context to preserve Referer headers and bypass CDN hotlink protection

---

## Third-Party Services

The extension interacts only with **weread.qq.com** (WeChat Reading), which is a service you have chosen to use. We have no affiliation with Tencent / WeChat Reading and are not responsible for their privacy practices.

---

## Changes to This Policy

If this policy is updated, the "Last updated" date at the top of this page will be revised. Continued use of the extension after changes constitutes acceptance of the updated policy.

---

## Contact

This extension is open source. If you have any privacy-related questions, please open an issue at:
[https://github.com/lippmann/weread-clipper/issues](https://github.com/lippmann/weread-clipper/issues)
