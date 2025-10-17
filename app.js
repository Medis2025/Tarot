/* app.js — Tarot 前端最小实现（SSE + DeepSeek 代理）
 * 说明：
 * 1) 若本地/同域部署后端：把 API_BASE 留空 ""（同源）
 * 2) 若后端是 Cloudflare Worker / Vercel：改成你的域名，如：
 *    const API_BASE = "https://tarot-proxy.yourname.workers.dev";
 */

const API_BASE = ""; // 同源时留空；跨域时填 Worker/Vercel 地址
const RUNTIME_ID = `run-${Date.now()}`;
let dialogId = "";   // 初始化后获得
let controller = null;   // AbortController（浏览器终止流）
let streaming = false;   // 当前是否在流式

// ------- DOM 元素（按你的页面结构自定义 id）-------
const $ = (sel) => document.querySelector(sel);
const inputEl = $("#user-input") || $("#ask-input") || $("#q");
const sendBtn = $("#send-btn") || $("#ask-btn");
const stopBtn = $("#stop-btn");
const reasonBox = $("#reason-box") || $("#reason");
const answerBox = $("#answer-box") || $("#answer");
const historyBox = $("#history") || $("#history-box"); // 可选
const cardsBox = $("#cards-box"); // 可选，显示卡牌
const statusEl = $("#status"); // 可选，状态栏

// -------- 工具函数 ----------
function setStatus(t) { if (statusEl) statusEl.textContent = t || ""; }
function appendText(el, txt) { if (!el) return; el.textContent += txt; el.scrollTop = el.scrollHeight; }
function clearBox(el) { if (!el) return; el.textContent = ""; }
function headersJSON() { return { "Content-Type": "application/json" }; }
function api(path) { return (API_BASE || "") + path; }

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ------- 读取 Cards.json（0 或 3 张卡）--------
async function loadCards() {
  try {
    // 你后端已支持 /static/Cards.json；GitHub Pages 上也放同名文件即可
    const js = await getJSON("/static/Cards.json").catch(() => getJSON("./Cards.json"));
    const cards = js?.cards || js || [];
    if (cardsBox) cardsBox.textContent = cards.length ? JSON.stringify(cards, null, 2) : "[]";
    return cards;
  } catch {
    if (cardsBox) cardsBox.textContent = "[]";
    return [];
  }
}

// ------- 初始化对话（允许 0 或 3 张卡）-------
async function initDialog() {
  const cards = await loadCards(); // 空数组也允许
  const body = {
    runtime_id: RUNTIME_ID,
    dialog_id: "",   // 让后端生成
    cards,           // 0 或 3
  };
  const r = await fetch(api("/api/dialog/init"), {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify(body),
  });
  const js = await r.json();
  if (!r.ok || !js.ok) throw new Error(js.error || "init failed");
  dialogId = js.dialog_id;
  setStatus(`会话就绪：${dialogId}`);
}

// ------- 可选：加载历史 -------
async function loadHistory() {
  try {
    const url = api(`/api/history?runtime_id=${encodeURIComponent(RUNTIME_ID)}&dialog_id=${encodeURIComponent(dialogId)}`);
    const js = await getJSON(url);
    if (historyBox) historyBox.textContent = JSON.stringify(js.history || [], null, 2);
  } catch {}
}

// ------- 停止当前流（浏览器 + 服务端）-------
async function stopStream() {
  try {
    if (controller) controller.abort();
  } catch {}
  try {
    await fetch(api("/api/chat/stop"), {
      method: "POST",
      headers: headersJSON(),
      body: JSON.stringify({ runtime_id: RUNTIME_ID, dialog_id: dialogId }),
    });
  } catch {}
  streaming = false;
  setStatus("已停止");
  if (sendBtn) sendBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
}

// ------- 开始流式请求 -------
async function startStream(userText, temperature = 0.2, top_p = 0.95) {
  if (!dialogId) await initDialog();

  clearBox(reasonBox);
  clearBox(answerBox);
  setStatus("连接中…");
  if (sendBtn) sendBtn.disabled = true;

  controller = new AbortController();
  streaming = true;
  if (stopBtn) stopBtn.disabled = false;

  const res = await fetch(api("/api/chat/stream"), {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({
      runtime_id: RUNTIME_ID,
      dialog_id: dialogId,
      user_text: userText,
      temperature,
      top_p,
    }),
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    setStatus(`请求失败：${res.status}`);
    streaming = false;
    if (sendBtn) sendBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    return;
  }

  // 读取 text/event-stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  setStatus("流式中…");

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 是按行分片的：以空行分段，段内若有 "event:" 和多行 "data:"。
      let parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const chunk of parts) {
        const lines = chunk.split("\n");
        let evt = "message"; // 默认
        let dataLines = [];
        for (const line of lines) {
          if (line.startsWith("event:")) {
            evt = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        const data = dataLines.join("\n");

        if (evt === "meta") {
          setStatus("已连接（meta）");
        } else if (evt === "reason") {
          appendText(reasonBox, data.replaceAll("\\n", "\n"));
        } else if (evt === "answer") {
          appendText(answerBox, data.replaceAll("\\n", "\n"));
        } else if (evt === "error") {
          setStatus(`错误：${data}`);
        } else if (evt === "done") {
          setStatus("完成");
          streaming = false;
          if (sendBtn) sendBtn.disabled = false;
          if (stopBtn) stopBtn.disabled = true;
        }
      }
    }
  } catch (e) {
    if (streaming) setStatus(`连接中断：${String(e)}`);
  } finally {
    try { await loadHistory(); } catch {}
    streaming = false;
    if (sendBtn) sendBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }
}

// ------- 事件绑定 -------
window.addEventListener("DOMContentLoaded", async () => {
  try {
    await initDialog();
    await loadHistory();
  } catch (e) {
    console.warn("init error:", e);
    setStatus("初始化失败（后端不可达？）");
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", async () => {
      const text = (inputEl?.value || "").trim();
      if (!text) return;
      await startStream(text);
    });
  }
  if (inputEl) {
    inputEl.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = (inputEl.value || "").trim();
        if (!text) return;
        await startStream(text);
      }
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener("click", stopStream);
  }
});

// ------- 可选：提供全局便捷函数（控制台调试）-------
window.TarotApp = {
  initDialog,
  loadHistory,
  startStream,
  stopStream,
  setApiBase(url) { 
    // 仅调试用：允许在控制台切换后端地址
    console.warn("Reset API base at runtime is not persisted; edit app.js for permanent change.");
    // eslint-disable-next-line no-global-assign
    API_BASE = url || "";
  }
};
