/**
 * popup.js
 * 处理 Popup 界面交互：发送问题给 Service Worker，展示回答
 */

const questionInput = document.getElementById("question-input");
const askButton = document.getElementById("ask-button");
const statusEl = document.getElementById("status");
const answerBox = document.getElementById("answer-box");
const dashboardLink = document.getElementById("dashboard-link");

/**
 * 设置状态提示文字
 */
function setStatus(text) {
  statusEl.textContent = text;
}

/**
 * 点击"提问"按钮
 */
askButton.addEventListener("click", async () => {
  const question = questionInput.value.trim();

  if (!question) {
    setStatus("请先输入问题～");
    return;
  }

  askButton.disabled = true;
  setStatus("AI 正在思考中…");
  answerBox.textContent = "";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ASK_QUESTION",
      question,
    });

    if (!response || typeof response !== "object") {
      throw new Error("未收到有效响应");
    }

    if (!response.ok) {
      throw new Error(response.error || "提问失败");
    }

    answerBox.textContent = response.answer;
    setStatus("回答完成，已保存到历史记录");
  } catch (err) {
    console.error("[popup] 提问失败:", err);
    answerBox.textContent = "出错了，请稍后重试～";
    setStatus(`错误：${err.message}`);
  } finally {
    askButton.disabled = false;
  }
});

// 支持 Ctrl+Enter 快捷提交
questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    askButton.click();
  }
});

// 打开学习看板（dashboard.html）
dashboardLink.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});
