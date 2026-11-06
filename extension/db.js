/**
 * db.js
 * IndexedDB 封装：统一管理 qa_history 和 video_analysis 两张表
 * 以 classic script 方式被 service-worker.js 和 dashboard.html 引用
 */

const DB_NAME = "ai_study_companion_db";
const DB_VERSION = 1;
const QA_STORE = "qa_history";
const ANALYSIS_STORE = "video_analysis";

/**
 * 打开（或创建）数据库
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 问答历史表
      if (!db.objectStoreNames.contains(QA_STORE)) {
        const qaStore = db.createObjectStore(QA_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        qaStore.createIndex("createdAt", "createdAt", { unique: false });
      }

      // 视频分析表
      if (!db.objectStoreNames.contains(ANALYSIS_STORE)) {
        const analysisStore = db.createObjectStore(ANALYSIS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        analysisStore.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * 保存一条问答记录
 * @param {string} question
 * @param {string} answer
 */
async function saveQA(question, answer) {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(QA_STORE, "readwrite");
      const store = tx.objectStore(QA_STORE);
      const record = {
        question,
        answer,
        createdAt: new Date().toISOString(),
      };
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (event) => reject(event.target.error);
    });
  } catch (err) {
    console.error("[db] saveQA 失败:", err);
    throw err;
  }
}

/**
 * 保存一条视频分析记录
 * @param {string} videoTitle
 * @param {object} analysisResult - { knowledgePoints: [...], suggestions: "..." }
 */
async function saveAnalysis(videoTitle, analysisResult) {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ANALYSIS_STORE, "readwrite");
      const store = tx.objectStore(ANALYSIS_STORE);
      const record = {
        videoTitle,
        knowledgePoints: analysisResult.knowledgePoints || [],
        suggestions: analysisResult.suggestions || "",
        createdAt: new Date().toISOString(),
      };
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (event) => reject(event.target.error);
    });
  } catch (err) {
    console.error("[db] saveAnalysis 失败:", err);
    throw err;
  }
}

/**
 * 获取所有问答历史，按时间倒序
 * @returns {Promise<Array>}
 */
async function getQAHistory() {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(QA_STORE, "readonly");
      const store = tx.objectStore(QA_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        const list = request.result || [];
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        resolve(list);
      };
      request.onerror = (event) => reject(event.target.error);
    });
  } catch (err) {
    console.error("[db] getQAHistory 失败:", err);
    return [];
  }
}

/**
 * 获取所有视频分析记录，按时间倒序
 * @returns {Promise<Array>}
 */
async function getAnalysisHistory() {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ANALYSIS_STORE, "readonly");
      const store = tx.objectStore(ANALYSIS_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        const list = request.result || [];
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        resolve(list);
      };
      request.onerror = (event) => reject(event.target.error);
    });
  } catch (err) {
    console.error("[db] getAnalysisHistory 失败:", err);
    return [];
  }
}
