/**
 * content-script.js
 * 在 YouTube / bilibili 页面中运行：
 * 1. 检测是否是视频播放页（排除 Shorts / 直播 / 播放列表 / 番剧等干扰页面）
 * 2. 注入"分析"按钮，位置随窗口宽度自适应
 * 3. B 站直接读取字幕；YouTube 仍收集用户粘贴的文本。然后发给 Service Worker 分析
 * 4. 展示分析结果（带加载动画、错误重试）
 *
 * 注意：与 service-worker.js 的消息格式保持不变：
 *   发送 { type: "ANALYZE_VIDEO", videoText, videoTitle }
 *   接收 { ok: boolean, result?: {...}, error?: string }
 */

const BUTTON_ID = "ai-study-companion-analyze-btn";
const PANEL_ID = "ai-study-companion-panel";
const SPINNER_STYLE_MARK = "data-ai-study-spinner";

// ===== 全局状态 =====
let isAnalyzing = false; // 分析中标志，用于防止重复点击/重复请求
let lastUrl = window.location.href; // 记录上一次检测到的 URL，供兜底轮询/MutationObserver 使用
let lastInitTime = 0; // 上一次执行 init() 的时间戳，用于防抖

/**
 * 判断当前页面是否为"可分析"的视频播放页
 * 规则：
 *   YouTube  -> 只接受 /watch 页面，排除 /shorts/、/live/、/playlist
 *   bilibili -> 只接受 /video/ 页面，排除 live. 子域、/bangumi/、搜索/首页
 */
function isVideoPage() {
  const host = window.location.hostname;
  const pathname = window.location.pathname;

  // ---- YouTube（含 www./m. 等域名变体） ----
  if (host.includes("youtube.com")) {
    if (pathname.includes("/shorts/")) return false; // 排除 Shorts
    if (pathname.includes("/live/")) return false; // 排除直播
    if (pathname.includes("/playlist")) return false; // 排除播放列表页
    return pathname === "/watch";
  }

  // ---- bilibili（含 m. 域名变体） ----
  if (host.includes("bilibili.com")) {
    if (host.includes("live.")) return false; // 排除直播间子域
    if (pathname.includes("/bangumi/")) return false; // 排除番剧播放页
    if (pathname === "/" || pathname.includes("/search")) return false; // 排除首页/搜索页
    return pathname.startsWith("/video/");
  }

  return false;
}

/**
 * 依次尝试一组 selector，返回第一个命中且有文本内容的元素
 * @param {string[]} selectors
 * @returns {Element|null}
 */
function tryQuerySelectors(selectors) {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      console.debug("[AI 学习伴侣] 尝试 selector:", selector, "结果:", el);
      if (el) return el;
    } catch (err) {
      console.debug("[AI 学习伴侣] selector 执行出错:", selector, err);
    }
  }
  return null;
}

/**
 * 从 YouTube 页面提取视频标题
 * 按优先级尝试多个 selector，全部失败则降级到 URL / document.title
 */
function getYouTubeTitle() {
  const selectors = [
    "h1 yt-formatted-string a#video-title-link",
    "h1 yt-formatted-string",
    "h1.title yt-formatted-string",
    "h1[aria-label]",
    ".watch-title-container h1",
  ];

  const el = tryQuerySelectors(selectors);
  if (el) {
    // h1[aria-label] 优先取 aria-label 属性，其余取文本内容
    const text = el.getAttribute?.("aria-label")?.trim() || el.textContent.trim();
    if (text) return text;
  }

  // 降级：meta[name='title']
  try {
    const metaEl = document.querySelector("meta[name='title']");
    console.debug("[AI 学习伴侣] 尝试 selector:", "meta[name='title']", "结果:", metaEl);
    if (metaEl?.content?.trim()) return metaEl.content.trim();
  } catch (err) {
    console.debug("[AI 学习伴侣] 读取 meta[name=title] 出错:", err);
  }

  // 降级：URL 参数 v
  try {
    const videoId = new URL(window.location.href).searchParams.get("v");
    if (videoId) return `YouTube 视频 (${videoId})`;
  } catch (err) {
    console.debug("[AI 学习伴侣] 解析 URL 参数出错:", err);
  }

  // 降级：document.title（通常形如 "视频标题 - YouTube"）
  if (document.title) {
    const cleaned = document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    if (cleaned) return cleaned;
  }

  return "YouTube 视频";
}

/**
 * 从 bilibili 页面提取视频标题
 * 按优先级尝试多个 selector，全部失败则降级到 URL / document.title
 */
function getBilibiliTitle() {
  const selectors = ["h1.video-title", "h1[title]", ".bpx-player-title"];

  const el = tryQuerySelectors(selectors);
  if (el) {
    const text = el.getAttribute?.("title")?.trim() || el.textContent.trim();
    if (text) return text;
  }

  // 降级：Open Graph og:title
  try {
    const ogEl = document.querySelector("meta[property='og:title']");
    console.debug("[AI 学习伴侣] 尝试 selector:", "meta[property='og:title']", "结果:", ogEl);
    if (ogEl?.content?.trim()) return ogEl.content.trim();
  } catch (err) {
    console.debug("[AI 学习伴侣] 读取 og:title 出错:", err);
  }

  // 降级：meta[name='title']
  try {
    const metaEl = document.querySelector("meta[name='title']");
    console.debug("[AI 学习伴侣] 尝试 selector:", "meta[name='title']", "结果:", metaEl);
    if (metaEl?.content?.trim()) return metaEl.content.trim();
  } catch (err) {
    console.debug("[AI 学习伴侣] 读取 meta[name=title] 出错:", err);
  }

  // 降级：从 URL 路径提取 BV/AV 号
  try {
    const match = window.location.pathname.match(/\/video\/(BV\w+|av\d+)/i);
    if (match) return `B 站视频 (${match[1]})`;
  } catch (err) {
    console.debug("[AI 学习伴侣] 解析 URL 路径出错:", err);
  }

  // 降级：document.title（通常形如 "视频标题_哔哩哔哩_bilibili"）
  if (document.title) {
    const cleaned = document.title.replace(/[_-]*哔哩哔哩.*$/i, "").trim();
    if (cleaned) return cleaned;
  }

  return "B 站视频";
}

/**
 * 获取当前视频标题（根据域名分发到对应平台的提取逻辑）
 */
function getVideoTitle() {
  const host = window.location.hostname;

  try {
    if (host.includes("youtube.com")) return getYouTubeTitle();
    if (host.includes("bilibili.com")) return getBilibiliTitle();
  } catch (err) {
    console.warn("[AI 学习伴侣] 获取视频标题失败:", err);
  }

  return document.title || "未命名视频";
}

/**
 * 根据当前窗口宽度计算按钮的响应式定位
 * - 宽屏 (>=1200px): 右上角
 * - 中屏 (>=768px): 右侧垂直居中
 * - 小屏 (<768px): 底部水平居中
 */
function getButtonPosition() {
  const vw = window.innerWidth;

  if (vw >= 1200) {
    return { top: "80px", right: "16px", bottom: "auto", left: "auto", transform: "none" };
  } else if (vw >= 768) {
    return {
      top: "50%",
      right: "16px",
      bottom: "auto",
      left: "auto",
      transform: "translateY(-50%)",
    };
  }
  return {
    bottom: "16px",
    left: "50%",
    top: "auto",
    right: "auto",
    transform: "translateX(-50%)",
  };
}

/**
 * 创建悬浮的"分析"按钮，并监听窗口 resize 做响应式调整
 */
function injectAnalyzeButton() {
  if (document.getElementById(BUTTON_ID)) return; // 避免重复注入

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.textContent = "🤖 分析";

  const pos = getButtonPosition();
  Object.assign(button.style, {
    position: "fixed",
    zIndex: "999999",
    padding: "8px 14px",
    background: "#4c6ef5",
    color: "#fff",
    border: "none",
    borderRadius: "20px",
    fontSize: "13px",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
    fontFamily: "sans-serif",
    transition: "all 0.3s ease",
    ...pos,
  });

  button.addEventListener("click", onAnalyzeButtonClick);
  document.body.appendChild(button);

  // 窗口尺寸变化时，重新计算按钮位置（响应式）
  window.addEventListener("resize", () => {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    Object.assign(btn.style, getButtonPosition());
  });
}

/**
 * 把视频文本发给 Service Worker 做知识点分析
 * @param {string} videoText
 * @param {string} videoTitle
 */
function sendAnalyze(videoText, videoTitle) {
  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_VIDEO",
      videoText,
      videoTitle,
    },
    (response) => {
      isAnalyzing = false;

      if (chrome.runtime.lastError) {
        showPanel(null, null, { error: chrome.runtime.lastError.message });
        return;
      }

      if (!response || !response.ok) {
        const errorMsg = (response && response.error) || "未知错误";
        showPanel(null, null, { error: errorMsg });
        return;
      }

      showPanel(null, response.result);
    }
  );
}

/**
 * B 站：不再弹输入框，直接读当前分 P 的字幕（没有字幕时用简介）
 */
function analyzeBilibiliVideo() {
  const bvidMatch = window.location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  const aidMatch = window.location.pathname.match(/\/video\/av(\d+)/i);
  let page = 1;
  try {
    page = Number(new URL(window.location.href).searchParams.get("p") || "1") || 1;
  } catch (err) {
    page = 1;
  }

  if (!bvidMatch && !aidMatch) {
    showPanel(null, null, { error: "无法识别当前视频" });
    isAnalyzing = false;
    return;
  }

  showPanel("正在读取 B 站字幕…", null);

  chrome.runtime.sendMessage(
    {
      type: "FETCH_BILIBILI_SUBTITLE",
      bvid: bvidMatch ? bvidMatch[1] : "",
      aid: aidMatch ? aidMatch[1] : "",
      page,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        isAnalyzing = false;
        showPanel(null, null, { error: chrome.runtime.lastError.message });
        return;
      }

      if (!response || !response.ok) {
        isAnalyzing = false;
        showPanel(null, null, { error: (response && response.error) || "读取字幕失败" });
        return;
      }

      const hint = response.source === "desc" ? "这个视频没有字幕，已改用简介。AI 正在分析…" : "已读取字幕，AI 正在分析…";
      showPanel(hint, null);
      sendAnalyze(response.videoText, response.videoTitle || getVideoTitle());
    }
  );
}

/**
 * 点击"分析"按钮。B 站直接读字幕；YouTube 仍让用户粘贴文本。
 * 带防抖：分析进行中时忽略重复点击
 */
function onAnalyzeButtonClick() {
  if (isAnalyzing) {
    console.warn("[AI 学习伴侣] 正在分析中，请稍候");
    return;
  }

  isAnalyzing = true;

  if (window.location.hostname.includes("bilibili.com")) {
    analyzeBilibiliVideo();
    return;
  }

  const videoText = window.prompt("请粘贴该视频的字幕或内容简介，AI 将为你分析知识点：", "");

  if (videoText === null) {
    isAnalyzing = false; // 用户取消
    return;
  }

  const trimmed = videoText.trim();
  if (!trimmed) {
    showPanel("请输入一些视频内容后再试～", null);
    isAnalyzing = false;
    return;
  }

  showPanel("AI 正在分析中，请稍候…", null);
  sendAnalyze(trimmed, getVideoTitle());
}

/**
 * 确保页面中存在 spinner 所需的 @keyframes 动画（只注入一次）
 */
function ensureSpinnerStyle() {
  if (document.querySelector(`style[${SPINNER_STYLE_MARK}]`)) return;

  const style = document.createElement("style");
  style.setAttribute(SPINNER_STYLE_MARK, "true");
  style.textContent = `
    @keyframes ai-study-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * 根据窗口宽度计算面板的响应式尺寸和定位
 */
function getPanelStyle() {
  const vw = window.innerWidth;

  if (vw < 768) {
    // 小屏幕：占满大部分宽度，居中显示在底部按钮上方
    return {
      width: "90vw",
      maxHeight: "60vh",
      top: "auto",
      bottom: "70px",
      left: "5vw",
      right: "auto",
    };
  }

  if (vw < 1200) {
    return {
      width: "250px",
      maxHeight: "320px",
      top: "120px",
      right: "16px",
      bottom: "auto",
      left: "auto",
    };
  }

  return {
    width: "280px",
    maxHeight: "320px",
    top: "120px",
    right: "16px",
    bottom: "auto",
    left: "auto",
  };
}

/**
 * 在页面上展示分析结果面板（简单的 div，而不是 alert，体验更好）
 * @param {string|null} loadingOrErrorText - 若非空，展示为纯文本提示（通常用于加载中）
 * @param {object|null} result - { knowledgePoints: [...], suggestions: "..." }
 * @param {object} [options] - { error?: string } 错误信息，若存在则显示错误 + 重试按钮
 */
function showPanel(loadingOrErrorText, result, options = {}) {
  let panel = document.getElementById(PANEL_ID);

  if (!panel) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }

  Object.assign(panel.style, {
    position: "fixed",
    zIndex: "999999",
    overflowY: "auto",
    padding: "12px 14px",
    background: "#fff",
    color: "#2c3e50",
    border: "1px solid #dcdde1",
    borderRadius: "10px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    fontSize: "13px",
    fontFamily: "sans-serif",
    lineHeight: "1.5",
    ...getPanelStyle(),
  });

  panel.innerHTML = "";

  const closeBtn = document.createElement("span");
  closeBtn.textContent = "✕";
  Object.assign(closeBtn.style, {
    position: "absolute",
    top: "6px",
    right: "10px",
    cursor: "pointer",
    color: "#868e96",
  });
  closeBtn.addEventListener("click", () => panel.remove());
  panel.appendChild(closeBtn);

  const title = document.createElement("div");
  title.textContent = "🤖 AI 视频分析";
  title.style.fontWeight = "bold";
  title.style.marginBottom = "8px";
  panel.appendChild(title);

  // ---- 错误状态：显示错误信息 + 重试按钮 ----
  if (options.error) {
    const errorDiv = document.createElement("div");
    errorDiv.style.color = "#e74c3c";
    errorDiv.textContent = `❌ ${options.error}`;
    panel.appendChild(errorDiv);

    const retryBtn = document.createElement("button");
    retryBtn.textContent = "🔄 重试";
    Object.assign(retryBtn.style, {
      marginTop: "8px",
      padding: "4px 12px",
      background: "#f39c12",
      color: "#fff",
      border: "none",
      borderRadius: "4px",
      fontSize: "12px",
      cursor: "pointer",
    });
    retryBtn.addEventListener("click", onAnalyzeButtonClick);
    panel.appendChild(retryBtn);
    return;
  }

  // ---- 加载/提示状态：显示旋转动画 + 文本 ----
  if (loadingOrErrorText) {
    ensureSpinnerStyle();

    const p = document.createElement("div");

    const spinner = document.createElement("span");
    Object.assign(spinner.style, {
      display: "inline-block",
      width: "12px",
      height: "12px",
      marginRight: "6px",
      border: "2px solid #f3f3f3",
      borderTop: "2px solid #4c6ef5",
      borderRadius: "50%",
      animation: "ai-study-spin 1s linear infinite",
      verticalAlign: "middle",
    });

    const text = document.createElement("span");
    text.textContent = loadingOrErrorText;

    p.appendChild(spinner);
    p.appendChild(text);
    panel.appendChild(p);
    return;
  }

  // ---- 正常结果状态：知识点列表 + 建议 ----
  if (result) {
    const kpTitle = document.createElement("div");
    kpTitle.textContent = "知识点：";
    kpTitle.style.fontWeight = "600";
    kpTitle.style.marginTop = "4px";
    panel.appendChild(kpTitle);

    const ul = document.createElement("ul");
    ul.style.margin = "4px 0 8px";
    ul.style.paddingLeft = "18px";
    (result.knowledgePoints || []).forEach((point) => {
      const li = document.createElement("li");
      li.textContent = point;
      ul.appendChild(li);
    });
    panel.appendChild(ul);

    const sugTitle = document.createElement("div");
    sugTitle.textContent = "学习建议：";
    sugTitle.style.fontWeight = "600";
    panel.appendChild(sugTitle);

    const sugText = document.createElement("div");
    sugText.textContent = result.suggestions || "暂无建议";
    panel.appendChild(sugText);

    appendRecommendationSlot(panel, result.knowledgePoints);
  }
}

/**
 * 在面板末尾追加"推荐视频"区块，异步加载，不阻塞已展示的知识点分析结果
 * @param {HTMLElement} panel
 * @param {string[]} knowledgePoints
 */
function appendRecommendationSlot(panel, knowledgePoints) {
  if (!knowledgePoints || !knowledgePoints.length) return;

  const slot = document.createElement("div");
  slot.style.marginTop = "10px";
  slot.style.paddingTop = "8px";
  slot.style.borderTop = "1px solid #eee";

  const heading = document.createElement("div");
  heading.textContent = "推荐视频：";
  heading.style.fontWeight = "600";
  slot.appendChild(heading);

  const status = document.createElement("div");
  status.textContent = "正在查找推荐视频…";
  status.style.color = "#868e96";
  status.style.fontSize = "12px";
  slot.appendChild(status);

  panel.appendChild(slot);

  chrome.runtime.sendMessage(
    { type: "GET_RECOMMENDATIONS", scope: "panel", knowledgePoints },
    (resp) => {
      // 面板可能在推荐返回前已被关闭或重绘，丢弃过期回调，避免写入失效节点
      if (!panel.contains(slot)) return;
      status.remove();

      if (chrome.runtime.lastError || !resp || !resp.ok) {
        slot.remove();
        return;
      }

      const items = [...(resp.supplement || []).slice(0, 2), ...(resp.advanced || []).slice(0, 1)];
      if (!items.length) {
        slot.remove();
        return;
      }
      items.forEach((video) => slot.appendChild(buildRecoItem(video)));
    }
  );
}

/**
 * 构建单条推荐视频的 DOM（纯 DOM API，不拼接 HTML 字符串）
 * @param {object} video
 * @returns {HTMLElement}
 */
function buildRecoItem(video) {
  const row = document.createElement("div");
  row.style.margin = "4px 0";
  row.style.fontSize = "12px";

  const link = document.createElement("a");
  // 只放行 http(s) 协议，防止外部数据注入 javascript: 等危险链接
  if (/^https?:\/\//i.test(video.url)) link.href = video.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = video.title;
  link.style.color = "#4c6ef5";
  row.appendChild(link);

  const meta = document.createElement("span");
  const minutes = video.duration ? Math.round(video.duration / 60) : null;
  meta.textContent =
    ` · ${video.platform === "youtube" ? "YouTube" : "B站"}` +
    (minutes ? ` · ${minutes}分钟` : "") +
    (video.source === "mock" ? " · 示例" : "");
  meta.style.color = "#adb5bd";
  row.appendChild(meta);

  return row;
}

/**
 * 初始化：检测视频页并注入/移除按钮
 * 页面不是视频页时移除按钮和分析面板，避免残留
 */
function init() {
  if (isVideoPage()) {
    injectAnalyzeButton();
  } else {
    const existingButton = document.getElementById(BUTTON_ID);
    if (existingButton) existingButton.remove();

    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel) existingPanel.remove();
  }
}

/**
 * 防抖版 init：200ms 内最多执行一次，避免短时间内被多个监听源重复触发
 */
function debouncedInit() {
  const now = Date.now();
  if (now - lastInitTime > 200) {
    lastInitTime = now;
    init();
  }
}

/**
 * 主方案：劫持 history.pushState / popstate，在 SPA 路由变化时触发检测
 * YouTube/B 站切换视频通常会调用 pushState 而不是整页刷新
 */
function setupHistoryListener() {
  const originalPushState = window.history.pushState;

  window.history.pushState = function (...args) {
    originalPushState.apply(this, args);
    console.debug("[AI 学习伴侣] 检测到 URL 变化 (pushState)");
    lastUrl = window.location.href;
    setTimeout(debouncedInit, 300);
  };

  window.addEventListener("popstate", () => {
    console.debug("[AI 学习伴侣] 检测到 popstate");
    lastUrl = window.location.href;
    setTimeout(debouncedInit, 300);
  });
}

/**
 * 降级方案：MutationObserver 兜底
 * 只监听 body 的直接子元素变化（subtree: false），且只在 URL 真正变化时才触发，
 * 避免 YouTube/B 站频繁的 DOM 动画引起无意义的重复检测
 */
function setupMutationFallback() {
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      setTimeout(debouncedInit, 300);
    }
  }).observe(document.body, {
    childList: true,
    subtree: false,
    attributes: false,
  });
}

// ===== 初始化入口 =====

// 首次加载检测
init();

// 主方案 + 降级方案同时启用：
// pushState 劫持覆盖绝大多数 SPA 路由场景，MutationObserver 作为兜底，
// 两者都通过 debouncedInit 防抖，避免重复触发。
setupHistoryListener();
setupMutationFallback();
