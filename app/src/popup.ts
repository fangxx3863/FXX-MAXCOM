// 置顶弹出接收窗口（popup.html 独立入口）：仅渲染某会话的收发/终端接收区，实时镜像。
// 由主窗口菜单「弹出并顶置接收窗口」创建（win11 任务管理器双击弹出风格）。
import "./styles.css";
import { makeApi, onEntries, onRaw } from "./api";
import { LogViewPage } from "./pages/logview";
import { TerminalPage } from "./pages/terminal";
import { t } from "./i18n";

const qs = new URLSearchParams(location.search);
const session = qs.get("session") ?? "";
const type = qs.get("type") === "terminal" ? "terminal" : "logview";

// 主题：popup 窗口无 <html data-theme>，按主窗口持久化设置恢复（缺省深色）
const THEME_PRESETS = new Set([
  "dark", "light", "midnight", "solar", "oled", "nord", "dracula",
  "solar-light", "orange", "red", "green", "pink", "purple",
]);
let themeId = "dark";
try {
  const saved = JSON.parse(localStorage.getItem("maxcom.settings") ?? "{}");
  if (THEME_PRESETS.has(saved.theme as string)) themeId = saved.theme as string;
} catch {
  /* 忽略坏数据 */
}
document.documentElement.dataset.theme = themeId;

const root = document.getElementById("pop-root")!;
root.className = "popup-body";
root.style.height = "100%";

if (!session) {
  const msg = document.createElement("div");
  msg.className = "popup-bar";
  msg.textContent = "缺少会话标识";
  root.appendChild(msg);
} else {
  const api = makeApi(session);
  if (type === "terminal") {
    // 终端：完整 xterm 面板（可读可发），实时镜像该会话原始流
    const term = new TerminalPage(root, api);
    onRaw((e) => {
      if (e.session === session) term.feed(e.bytes);
    });
  } else {
    // 收发：时间戳-触发式日志视图，实时镜像该会话 entries 批
    const bar = document.createElement("div");
    bar.className = "popup-bar";
    const auto = document.createElement("input");
    auto.type = "checkbox";
    auto.checked = true;
    const autoLabel = document.createElement("label");
    autoLabel.className = "chk";
    autoLabel.append(auto, document.createTextNode(t("log.autoscroll")));
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const clearBtn = document.createElement("button");
    clearBtn.textContent = t("common.clear");
    bar.append(autoLabel, spacer, clearBtn);
    const view = document.createElement("div");
    view.id = "log-view";
    root.append(bar, view);
    const page = new LogViewPage(view, { autoscroll: auto, getTsMode: () => "none" });
    clearBtn.addEventListener("click", () => page.clear());
    onEntries((e) => {
      if (e.session === session) page.append(e.batch);
    });
  }
}

// 初始化完成标记（供 popup 回归测试断言）
(window as unknown as { __MAXCOM_POPUP_READY__?: boolean }).__MAXCOM_POPUP_READY__ = true;
