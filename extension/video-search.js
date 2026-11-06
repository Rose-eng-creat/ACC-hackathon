/**
 * video-search.js
 * 学习视频搜索的唯一出口。调用方只依赖 searchVideos() 的函数签名和归一化后的返回结构。
 *
 * 当前是 mock 实现（规则生成，不是写死的假数据），用于先搭好整条推荐链路。
 * 换成真实 anysearch（或其他）API 时，只需要改 _searchImpl 内部指向，
 * 调用方（recommendation.js）完全不用改。
 */

const SEARCH_KEY_STORAGE = "searchApiKey";

/**
 * 读取搜索 API Key（真实 API 接入时使用）
 * 用 chrome.storage.local 而不是 localStorage —— Service Worker 里没有 window/localStorage
 */
async function getSearchApiKey() {
  const result = await chrome.storage.local.get(SEARCH_KEY_STORAGE);
  return result[SEARCH_KEY_STORAGE] || "";
}

/**
 * 写入搜索 API Key
 * @param {string} key
 */
async function setSearchApiKey(key) {
  await chrome.storage.local.set({ [SEARCH_KEY_STORAGE]: String(key || "").trim() });
}

/**
 * 搜索学习视频（唯一出口）
 * @param {string} query - 搜索查询词
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<{id,title,url,platform,description,relevance_score,duration,source}>>}
 */
async function searchVideos(query, opts = {}) {
  const limit = opts.limit ?? 5;
  const raw = await _searchImpl(query, opts);
  return raw.map(normalizeVideo).filter(Boolean).slice(0, limit);
}

/**
 * 内部分发：当前指向 mock，接入真实 API 时改这里
 */
async function _searchImpl(query, opts) {
  return _mockSearch(query, opts); // 以后: return _anysearchSearch(query, opts)
}

/**
 * Mock 实现：规则生成，不是写死的假视频
 * - 标题用模板拼接，始终和查询词相关
 * - 链接指向 B 站/YouTube 的真实搜索结果页（可以真实点击打开，不会 404）
 * - 相关度和时长由查询词的简单哈希确定性生成，同一查询词每次结果一致
 */
async function _mockSearch(query, opts) {
  await new Promise((resolve) => setTimeout(resolve, 200)); // 模拟网络延迟，便于验证加载态

  const templates = ["教程", "实战精讲", "常见误区"];
  const hash = Array.from(String(query)).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  return templates.map((suffix, i) => {
    const platform = (hash + i) % 2 === 0 ? "bilibili" : "youtube";
    const q = encodeURIComponent(`${query} ${suffix}`);
    const url =
      platform === "bilibili"
        ? `https://search.bilibili.com/all?keyword=${q}`
        : `https://www.youtube.com/results?search_query=${q}`;

    return {
      id: `mock-${hash}-${i}`,
      title: `${query} ${suffix}`,
      url,
      platform,
      description: `关于「${query}」的${suffix}内容`,
      relevance_score: Math.max(0.6, 0.95 - i * 0.12),
      duration: 300 + ((hash + i * 97) % 1500),
      source: "mock",
    };
  });
}

/**
 * 防御层：归一化搜索结果，兼容真实 API 字段缺失/类型不对的情况
 * @param {object} v
 * @returns {object|null} 无效数据返回 null（比如 url 不是 http(s)）
 */
function normalizeVideo(v) {
  if (!v || typeof v.url !== "string" || !/^https?:\/\//i.test(v.url)) return null;

  return {
    id: String(v.id || "").slice(0, 100),
    title: String(v.title || "未命名视频").slice(0, 100),
    url: v.url,
    platform: v.platform === "youtube" ? "youtube" : "bilibili",
    description: String(v.description || "").slice(0, 200),
    relevance_score: Math.min(1, Math.max(0, Number(v.relevance_score) || 0.5)),
    duration: Number.isFinite(v.duration) ? v.duration : null,
    source: v.source === "anysearch" ? "anysearch" : "mock",
  };
}
