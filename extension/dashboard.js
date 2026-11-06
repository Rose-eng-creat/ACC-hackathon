/**
 * dashboard.js
 * 学习看板页面逻辑：从 IndexedDB 读取视频分析和问答历史并展示
 */

const analysisListEl = document.getElementById("analysis-list");
const qaListEl = document.getElementById("qa-list");
const refreshBtn = document.getElementById("refresh-btn");

// 推荐视频相关 DOM 引用
const recoListEl = document.getElementById("reco-list");
const recoRefreshBtn = document.getElementById("reco-refresh");
const recoTabs = document.querySelectorAll(".reco-tab");
let recoData = null;
let recoTab = "supplement";

/**
 * 格式化时间显示
 */
function formatTime(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleString("zh-CN");
  } catch {
    return isoString;
  }
}

/**
 * 渲染视频分析列表
 */
function renderAnalysisList(items) {
  analysisListEl.innerHTML = "";

  if (!items || items.length === 0) {
    analysisListEl.innerHTML = '<div class="empty">暂无分析记录，去 YouTube/B 站试试"分析此视频"吧～</div>';
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatTime(item.createdAt);
    card.appendChild(meta);

    const title = document.createElement("div");
    title.className = "q";
    title.textContent = item.videoTitle || "未命名视频";
    card.appendChild(title);

    const ul = document.createElement("ul");
    (item.knowledgePoints || []).forEach((point) => {
      const li = document.createElement("li");
      li.textContent = point;
      ul.appendChild(li);
    });
    card.appendChild(ul);

    if (item.suggestions) {
      const sug = document.createElement("div");
      sug.className = "a";
      sug.textContent = `建议：${item.suggestions}`;
      card.appendChild(sug);
    }

    analysisListEl.appendChild(card);
  });
}

/**
 * 渲染问答历史列表
 */
function renderQAList(items) {
  qaListEl.innerHTML = "";

  if (!items || items.length === 0) {
    qaListEl.innerHTML = '<div class="empty">暂无问答记录，去 Popup 里提个问题试试吧～</div>';
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatTime(item.createdAt);
    card.appendChild(meta);

    const q = document.createElement("div");
    q.className = "q";
    q.textContent = `Q: ${item.question}`;
    card.appendChild(q);

    const a = document.createElement("div");
    a.className = "a";
    a.textContent = `A: ${item.answer}`;
    card.appendChild(a);

    qaListEl.appendChild(card);
  });
}

/**
 * ===== 推荐视频功能 =====
 * 数据来自后台 service worker 的 GET_RECOMMENDATIONS 消息（basis: 历史分析知识点）
 */

/**
 * 构建单条推荐视频卡片（复用 .card/.empty 风格）
 * @param {object} video
 */
function buildRecoCard(video) {
  const card = document.createElement("div");
  card.className = "card reco-card";

  const link = document.createElement("a");
  if (/^https?:\/\//i.test(video.url)) link.href = video.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = video.title;
  card.appendChild(link);

  const meta = document.createElement("div");
  meta.className = "meta";
  const minutes = video.duration ? Math.round(video.duration / 60) : null;
  meta.textContent =
    `${video.platform === "youtube" ? "▶️ YouTube" : "🎬 B站"}` +
    (minutes ? ` · ${minutes} 分钟` : "") +
    (video.source === "mock" ? " · 示例" : "");
  card.appendChild(meta);

  if (video.description) {
    const desc = document.createElement("div");
    desc.className = "a";
    desc.textContent = video.description;
    card.appendChild(desc);
  }

  return card;
}

/**
 * 根据当前 tab 渲染推荐列表
 */
function renderRecommendations() {
  recoListEl.innerHTML = "";
  const items = (recoData && recoData[recoTab]) || [];

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = recoData?.degraded
      ? "暂时无法获取推荐，请稍后刷新"
      : "还没有可推荐的内容，先去分析一个视频吧～";
    recoListEl.appendChild(empty);
    return;
  }

  items.forEach((video) => recoListEl.appendChild(buildRecoCard(video)));
}

/**
 * 加载推荐数据（force=true 时绕过缓存强制重新计算）
 */
function loadRecommendations(force = false) {
  recoListEl.innerHTML = '<div class="empty">加载中…</div>';
  chrome.runtime.sendMessage({ type: "GET_RECOMMENDATIONS", scope: "dashboard", force }, (resp) => {
    recoData = chrome.runtime.lastError || !resp ? { supplement: [], advanced: [], degraded: true } : resp;
    renderRecommendations();
  });
}

recoTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    recoTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    recoTab = tab.dataset.type;
    renderRecommendations();
  });
});

recoRefreshBtn.addEventListener("click", () => loadRecommendations(true));

/**
 * 加载并渲染所有数据
 */
async function loadDashboard() {
  // 推荐区独立加载，不 await —— 推荐慢不应该拖住历史记录区块的展示
  loadRecommendations(false);

  try {
    const [analysisHistory, qaHistory] = await Promise.all([
      getAnalysisHistory(),
      getQAHistory(),
    ]);
    renderAnalysisList(analysisHistory);
    renderQAList(qaHistory);
  } catch (err) {
    console.error("[dashboard] 加载数据失败:", err);
    analysisListEl.innerHTML = '<div class="empty">加载失败，请刷新重试</div>';
    qaListEl.innerHTML = '<div class="empty">加载失败，请刷新重试</div>';
  }
}

refreshBtn.addEventListener("click", loadDashboard);

// 页面加载时自动拉取一次数据
loadDashboard();
