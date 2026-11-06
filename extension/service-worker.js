/**
 * service-worker.js
 * 后台服务：处理来自 Popup 和 Content Script 的消息。
 * 模型请求由扩展直接发出，分析结果写入本地 IndexedDB。
 */

importScripts("db.js", "bilibili-subtitle.js", "ai-config.js", "ai.js", "video-search.js", "recommendation.js");

/**
 * 调用模型回答问题，并结合本地最近问答作为上下文
 * @param {string} question
 * @returns {Promise<string>} answer
 */
async function callAskQuestionAPI(question) {
  const profile = await buildLocalProfile();
  const history = await getQAHistory();
  const recentHistory = history.slice(0, 5).reverse();
  return askQuestion(question, profile, recentHistory);
}

/**
 * 调用模型分析视频内容
 * @param {string} videoText
 * @param {string} videoTitle
 * @returns {Promise<{knowledgePoints: string[], suggestions: string}>}
 */
async function callAnalyzeVideoAPI(videoText, videoTitle) {
  const profile = await buildLocalProfile();
  const titledText = videoTitle ? "标题：" + videoTitle + "\n" + videoText : videoText;
  return analyzeVideo(titledText, profile);
}

/**
 * 统一消息监听入口
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 校验消息格式
  if (!message || typeof message.type !== "string") {
    sendResponse({ ok: false, error: "消息格式不正确" });
    return false;
  }

  if (message.type === "ASK_QUESTION") {
    handleAskQuestion(message, sendResponse);
    return true; // 保持消息通道开放，等待异步响应
  }

  if (message.type === "ANALYZE_VIDEO") {
    handleAnalyzeVideo(message, sendResponse);
    return true;
  }

  if (message.type === "FETCH_BILIBILI_SUBTITLE") {
    handleFetchBilibiliSubtitle(message, sender, sendResponse);
    return true;
  }

  if (message.type === "GET_RECOMMENDATIONS") {
    handleGetRecommendations(message, sendResponse);
    return true;
  }

  // 未知消息类型
  sendResponse({ ok: false, error: `未知的消息类型: ${message.type}` });
  return false;
});

/**
 * 处理提问请求
 */
async function handleAskQuestion(message, sendResponse) {
  try {
    const question = (message.question || "").trim();
    if (!question) {
      sendResponse({ ok: false, error: "问题内容不能为空" });
      return;
    }

    const answer = await callAskQuestionAPI(question);
    await saveQA(question, answer);

    sendResponse({ ok: true, answer });
  } catch (err) {
    console.error("[service-worker] 处理 ASK_QUESTION 失败:", err);
    sendResponse({ ok: false, error: err.message || "处理问题时发生错误" });
  }
}

/**
 * 把字幕行收成一段文本。过长时截断，避免分析请求超出模型上下文。
 * @param {string[]} lines
 * @returns {string}
 */
function linesToVideoText(lines) {
  const text = (lines || []).join("\n").trim();
  if (!text) throw new Error("字幕内容是空的");
  const maxLen = 12000;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n（字幕较长，已截取前半部分）";
}

/**
 * 在当前 B 站标签页里读取字幕。请求跑在页面主世界，才能带上登录态。
 */
async function handleFetchBilibiliSubtitle(message, sender, sendResponse) {
  try {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "无法定位当前视频页面" });
      return;
    }

    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: fetchBilibiliContentInPage,
      args: [message.bvid || "", message.aid || "", Number(message.page) || 1],
    });
    const result = injected && injected[0] && injected[0].result;
    if (!result || !result.ok) {
      sendResponse({ ok: false, error: (result && result.error) || "读取字幕失败" });
      return;
    }

    if (result.source === "subtitle" && !result.lines && result.subtitleUrl) {
      const response = await fetch(result.subtitleUrl);
      if (!response.ok) throw new Error("下载字幕失败 " + response.status);
      const subtitle = await response.json();
      const body = (subtitle && subtitle.body) || [];
      const lines = [];
      for (const item of body) {
        const content = ((item && item.content) || "").trim();
        if (!content || content === lines[lines.length - 1]) continue;
        lines.push(content);
      }
      result.lines = lines;
    }

    const videoText = result.videoText || linesToVideoText(result.lines);
    sendResponse({
      ok: true,
      videoText,
      videoTitle: result.videoTitle || "B 站视频",
      source: result.source || "subtitle",
      lanDoc: result.lanDoc || "",
    });
  } catch (err) {
    console.error("[service-worker] 读取 B 站字幕失败:", err);
    sendResponse({ ok: false, error: err.message || "读取字幕失败" });
  }
}

/**
 * 处理视频分析请求
 */
async function handleAnalyzeVideo(message, sendResponse) {
  try {
    const videoText = (message.videoText || "").trim();
    if (!videoText) {
      sendResponse({ ok: false, error: "视频内容不能为空" });
      return;
    }

    const videoTitle = message.videoTitle || "未命名视频";
    const analysisResult = await callAnalyzeVideoAPI(videoText, videoTitle);
    await saveAnalysis(videoTitle, analysisResult);

    sendResponse({ ok: true, result: analysisResult });
  } catch (err) {
    console.error("[service-worker] 处理 ANALYZE_VIDEO 失败:", err);
    sendResponse({ ok: false, error: err.message || "分析视频时发生错误" });
  }
}

/**
 * 处理推荐视频请求
 * scope: "panel"（分析后立即推荐，基于当前视频知识点）
 *        "dashboard"（看板完整推荐，基于全部历史知识点，带缓存）
 * 始终 sendResponse({ok:true, ...})，推荐失败只是"没有推荐内容"，不是错误
 */
async function handleGetRecommendations(message, sendResponse) {
  try {
    if (message.scope === "dashboard") {
      const data = await getDashboardRecommendations({ force: !!message.force });
      sendResponse({ ok: true, ...data });
    } else {
      const data = await buildRecommendations({ knowledgePoints: message.knowledgePoints, limit: 3 });
      sendResponse({ ok: true, ...data });
    }
  } catch (err) {
    console.error("[service-worker] 处理 GET_RECOMMENDATIONS 失败:", err);
    sendResponse({ ok: true, supplement: [], advanced: [], degraded: true });
  }
}

// 插件安装/更新时的日志，便于调试
chrome.runtime.onInstalled.addListener(() => {
  console.log("[AI 学习伴侣] 插件已安装/更新，Service Worker 已启动");
});
