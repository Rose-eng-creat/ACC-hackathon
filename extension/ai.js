/**
 * 在扩展 Service Worker 里直接调用 OpenAI 兼容接口。
 * 依赖 ai-config.js 里的 AI_API_KEY / AI_BASE_URL / AI_MODEL / AI_TIMEOUT_MS。
 */

function tryParseJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (err) {
    // 继续从代码块或花括号里提取
  }

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch (err) {
      // 继续
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (err) {
      return null;
    }
  }

  return null;
}

/**
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ json?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function chatCompletion(messages, options) {
  const useJson = Boolean(options && options.json);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const body = {
    model: AI_MODEL,
    messages,
    temperature: 0.7,
  };
  if (useJson) body.response_format = { type: "json_object" };

  try {
    const response = await fetch(AI_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + AI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (err) {
      data = { error: { message: raw.slice(0, 200) } };
    }

    if (!response.ok) {
      const message =
        (data.error && (data.error.message || data.error.code)) ||
        data.message ||
        "HTTP " + response.status;
      const error = new Error("AI 请求失败: " + message);
      error.status = response.status;
      throw error;
    }

    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("AI 响应超时（超过 " + AI_TIMEOUT_MS / 1000 + " 秒），请稍后重试");
    }
    if (err.message === "Failed to fetch") {
      throw new Error("无法连接模型服务 " + AI_BASE_URL + "。请在扩展管理页重新加载插件后再试。");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} videoText
 * @param {string} userProfile
 * @returns {Promise<{knowledgePoints: string[], suggestions: string}>}
 */
async function analyzeVideo(videoText, userProfile) {
  const messages = [
    {
      role: "system",
      content:
        "你是一位专业的学习辅助 AI，擅长从视频内容中提炼知识点并给出个性化学习建议。\n" +
        "用户的学习档案：" +
        (userProfile || "暂无档案信息，请给出通用性建议") +
        "\n\n请严格按照以下 JSON 格式返回分析结果，不要添加任何额外说明文字：\n" +
        '{\n  "knowledgePoints": ["知识点1", "知识点2", "知识点3"],\n  "suggestions": "针对该用户的学习建议"\n}',
    },
    {
      role: "user",
      content: "请分析以下视频内容，提炼出 3-5 个核心知识点，并给出学习建议。\n\n【视频内容】\n" + videoText,
    },
  ];

  let text;
  try {
    text = await chatCompletion(messages, { json: true });
  } catch (err) {
    if (/response_format|json_object|unsupported/i.test(err.message)) {
      text = await chatCompletion(messages, { json: false });
    } else {
      throw err;
    }
  }

  const parsed = tryParseJSON(text);
  if (parsed && Array.isArray(parsed.knowledgePoints)) {
    return {
      knowledgePoints: parsed.knowledgePoints,
      suggestions: parsed.suggestions || "暂无具体建议",
    };
  }

  console.warn("[ai] analyzeVideo 返回内容无法解析为预期 JSON，使用降级结构");
  return {
    knowledgePoints: text ? [text] : ["AI 未能提取到明确的知识点"],
    suggestions: "建议重新尝试分析，或检查视频内容是否完整",
  };
}

/**
 * @param {string} question
 * @param {string} userProfile
 * @param {Array<{question: string, answer: string}>} recentHistory
 * @returns {Promise<string>}
 */
async function askQuestion(question, userProfile, recentHistory) {
  const history = recentHistory || [];
  const historyText = history.length
    ? history.map((item, idx) => idx + 1 + ". 问：" + item.question + "\n   答：" + item.answer).join("\n")
    : "暂无历史记录";

  const text = await chatCompletion([
    {
      role: "system",
      content:
        "你是一位耐心、专业的学习辅助 AI，帮助用户解答学习中遇到的问题。\n" +
        "用户的学习档案：" +
        (userProfile || "暂无档案信息") +
        "\n\n用户最近的问答历史（供参考，帮助你理解用户的学习脉络）：\n" +
        historyText +
        "\n\n请用简洁、易懂的语言直接回答用户的问题，可以结合用户的学习历史给出更有针对性的解释。",
    },
    { role: "user", content: question },
  ]);

  return (text || "").trim() || "抱歉，AI 暂时无法回答这个问题，请换个方式提问试试。";
}

/**
 * 用本地分析记录拼一段简短学习档案，代替原来后端 users.profile。
 * @returns {Promise<string>}
 */
async function buildLocalProfile() {
  const analyses = await getAnalysisHistory();
  const points = [];
  for (const item of analyses.slice(0, 5)) {
    const list = item.knowledgePoints || [];
    for (const point of list) {
      if (points.length >= 8) break;
      if (point && points.indexOf(point) === -1) points.push(point);
    }
    if (points.length >= 8) break;
  }
  return points.length ? "最近学过：" + points.join("；") : "";
}
