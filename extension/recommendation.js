/**
 * recommendation.js
 * 学习视频推荐编排：知识点 -> 查询词 -> 并行搜索 -> 排序去重
 *
 * 本轮查询词生成是纯规则拼接，不调用 AI（保持链路零外部依赖、确定性强、好测试）。
 * 等换成真实搜索 API 时，可以考虑把查询词生成升级成 AI 驱动。
 *
 * 依赖 video-search.js 的 searchVideos()，依赖 db.js 的 getAnalysisHistory()
 * （由 service-worker.js 的 importScripts 保证加载顺序）
 */

/**
 * 纯规则生成推荐查询词
 * @param {string[]} knowledgePoints
 * @returns {{supplement: string[], advanced: string[]}}
 */
function generateRecommendationQueries(knowledgePoints) {
  const points = (knowledgePoints || []).filter(Boolean).slice(0, 3);
  return {
    supplement: points.map((k) => `${k} 教程`),
    advanced: points.map((k) => `${k} 进阶`),
  };
}

/**
 * 按 url 去重
 */
function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((v) => {
    if (seen.has(v.url)) return false;
    seen.add(v.url);
    return true;
  });
}

/**
 * 编排推荐结果：知识点 -> 查询词 -> 并行搜索 -> 排序去重
 * 永不抛出异常，失败时返回 degraded: true，调用方据此判断是否降级展示
 * @param {{knowledgePoints: string[], limit?: number}} params
 * @returns {Promise<{supplement: object[], advanced: object[], degraded: boolean}>}
 */
async function buildRecommendations({ knowledgePoints, limit = 3 }) {
  const empty = { supplement: [], advanced: [], degraded: true };
  if (!knowledgePoints || !knowledgePoints.length) return empty;

  try {
    const { supplement, advanced } = generateRecommendationQueries(knowledgePoints);

    const run = async (queries, type) => {
      if (!queries.length) return [];
      const settled = await Promise.allSettled(queries.map((q) => searchVideos(q, { limit })));
      const all = settled.filter((s) => s.status === "fulfilled").flatMap((s) => s.value);
      return dedupeByUrl(all)
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, limit)
        .map((v) => ({ ...v, type }));
    };

    const [supResult, advResult] = await Promise.all([
      run(supplement, "supplement"),
      run(advanced, "advanced"),
    ]);

    return { supplement: supResult, advanced: advResult, degraded: false };
  } catch (err) {
    console.error("[recommendation] buildRecommendations 失败:", err);
    return empty;
  }
}

// ===== Dashboard 场景：汇总历史知识点 + 缓存 =====

const RECO_CACHE_KEY = "recoCache";
const RECO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时

/**
 * 获取 Dashboard 的完整推荐列表（基于全部历史分析记录的知识点）
 * 带缓存：指纹相同且未过期时直接返回缓存，force=true 时强制重新计算
 * @param {{force?: boolean}} [options]
 */
async function getDashboardRecommendations({ force = false } = {}) {
  const history = await getAnalysisHistory();
  const fingerprint = history.length ? `${history[0].id}-${history.length}` : "empty";

  if (!force) {
    try {
      const cached = await chrome.storage.local.get(RECO_CACHE_KEY);
      const entry = cached[RECO_CACHE_KEY];
      if (entry && entry.fingerprint === fingerprint && Date.now() - entry.ts < RECO_CACHE_TTL_MS) {
        return entry.data;
      }
    } catch (err) {
      console.warn("[recommendation] 读取推荐缓存失败，忽略缓存:", err);
    }
  }

  // 汇总最近 10 条分析记录里的知识点，去重，最多 15 个
  const points = [];
  for (const item of history.slice(0, 10)) {
    for (const p of item.knowledgePoints || []) {
      if (points.length >= 15) break;
      if (p && !points.includes(p)) points.push(p);
    }
  }

  const data = await buildRecommendations({ knowledgePoints: points, limit: 5 });

  try {
    await chrome.storage.local.set({ [RECO_CACHE_KEY]: { fingerprint, ts: Date.now(), data } });
  } catch (err) {
    console.warn("[recommendation] 写入推荐缓存失败，忽略:", err);
  }

  return data;
}
