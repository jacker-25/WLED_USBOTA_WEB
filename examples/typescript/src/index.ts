/**
 * WLED Web Flash —— 三步向导 + esptool-js 烧录
 * ----------------------------------------------------------------
 * ① Connect   → Web Serial + ESPLoader.main() 识别芯片
 * ② Select    → 型号库 models.ts 弹窗选择
 * ③ Firmware  → GitHub Releases 拉取（github.ts）+ 烧录
 */

// ========= 构建配置开关 =========
// 调试时把 LOG_WINDOW / LOG_BUFFER 改成 true 即可重新开启
const CONFIG = {
  LOG_WINDOW: false,   // false = 关闭日志窗口显示；true = 烧录时打开日志面板
  LOG_BUFFER: true,    // false = 不缓存日志（右上角 Log 按钮导出会是空包）；true = 仍然缓存，可随时导出 zip
};
// ================================

import {
  ESPLoader,
  FlashOptions,
  LoaderOptions,
  Transport,
} from "../../../lib";
import { serial } from "web-serial-polyfill";

import { WLED_MODELS, CHIP_LABEL, setModels, type WledModel } from "./models.js";
import {
  fetchReleaseIndex,
  fetchMetaIndex,
  getBinVersions,
  raceFetchFirmware,
  fmtSize,
  type ReleaseIndex,
  type RemoteBinVersion,
} from "./fw-source.js";

// ---------------------------------------------------------------------------
// 浏览器环境变量
// ---------------------------------------------------------------------------
const serialLib: any = !(globalThis as any).navigator.serial && (globalThis as any).navigator.usb
  ? (serial as any)
  : (globalThis as any).navigator.serial;
declare let CryptoJS: any;
declare const Terminal: any;
declare const JSZip: any;       // 来自 CDN
declare const bootstrap: any;  // Bootstrap 5.3 JS Bundle（来自 CDN）

// ---------------------------------------------------------------------------
// 日志缓存（用于 zip 打包下载）
// ---------------------------------------------------------------------------
interface LogLine { ts: number; level: string; msg: string; }
const logLines: LogLine[] = [];

// ---------------------------------------------------------------------------
// 向导状态
// ---------------------------------------------------------------------------
interface WizardState {
  step: number;
  port: any;
  transport: Transport | null;
  esploader: ESPLoader | null;
  chip: string | null;
  chipMac: string | null;
  chipFlash: string | null;
  model: WledModel | null;
  release: ReleaseIndex | null;
  pickedVersion: RemoteBinVersion | null;
  baudRate: number;                           // 烧录波特率（115200/460800/921600）
  flashing: boolean;
  t0: number;
  timer: number | null;
}

const S: WizardState = {
  step: 1,
  port: null,
  transport: null,
  esploader: null,
  chip: null,
  chipMac: null,
  chipFlash: null,
  model: null,
  release: null,
  pickedVersion: null,
  baudRate: 115200,                           // 默认保守 115200
  flashing: false,
  t0: 0,
  timer: null,
};

const $ = (id: string) => document.getElementById(id)!;

/** 全局状态区切换：'text'（静态文字）| 'flash'（进度条）| 'done'（完成勾圈） */
function showStatus(mode: "text" | "flash" | "done") {
  const wizText = $("wiz-text") as HTMLElement;
  const pb = $("progress-box") as HTMLElement;
  const db = $("done-box") as HTMLElement;
  wizText.classList.toggle("hidden", mode !== "text");
  pb.classList.toggle("hidden", mode !== "flash");
  db.classList.toggle("hidden", mode !== "done");
}

// 刷新页面 → 强制关掉所有运行态残留
window.addEventListener("DOMContentLoaded", () => {
  showStatus("text");
});

// ---------------------------------------------------------------------------
// 终端 + 日志（保留简易日志面板，不依赖 xterm）
// ---------------------------------------------------------------------------
const logEl = $("logBd");
const logBox = $("log-box");
function log(msg: string, level: "tm" | "ti" | "ts" | "te" | "tw" = "tm") {
  // 缓存（用于后续打包 zip，右上角 Log 按钮导出）
  if (CONFIG.LOG_BUFFER) logLines.push({ ts: Date.now(), level, msg });
  // 渲染到 DOM（受 LOG_WINDOW 开关控制）
  if (CONFIG.LOG_WINDOW) {
    const div = document.createElement("div");
    div.className = "ll " + level;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
}
function logInfo(msg: string) { log(msg, "ti"); }
function logOk(msg: string)   { log(msg, "ts"); }
function logErr(msg: string)  { log(msg, "te"); }
function logWarn(msg: string) { log(msg, "tw"); }

// esptool-js 回调用的 terminal（输出到我们自己的 log 面板）
const esptoolTerminal = {
  clean() { logEl.innerHTML = ""; },
  writeLine(data: string) { log(data, "tm"); },
  write(data: string) { log(data, "tm"); },
};

// ---------------------------------------------------------------------------
// 向导渲染
// ---------------------------------------------------------------------------
// n=-1: 全部黑白（初始态）
// n=1/2/3: step n 彩色 current, 之前的彩色 done, 之后的黑白
// n=4: 烧录完成 — step-1 彩色 done, step-2/3 黑白 done
function goto(n: number) {
  S.step = n;
  for (let i = 1; i <= 3; i++) {
    const stepEl = $("step-" + i);
    const lineEl = document.getElementById("line-" + i);

    if (n === 4) {
      // 烧录完成：step-1 保持彩色，step-2/3 全部黑白（done 但不高亮）
      stepEl.classList.toggle("done", i === 1);
      stepEl.classList.toggle("current", false);
      stepEl.classList.toggle("pending", i >= 2);
      if (lineEl) lineEl.classList.toggle("done", i === 1);
      continue;
    }

    stepEl.classList.toggle("done", n > 0 && i < n);
    stepEl.classList.toggle("current", i === n);
    stepEl.classList.toggle("pending", n > 0 && i > n);
    if (lineEl) {
      lineEl.classList.toggle("done", n > 0 && i < n);
      lineEl.classList.toggle("pending", n > 0 && i >= n);
    }
  }
}
function setLabel(i: number, html: string) {
  const el = $("label-" + i) as HTMLElement;
  el.innerHTML = html;
}
function setFoot(html: string) { $("foot").textContent = html; }

// ---------------------------------------------------------------------------
// 弹窗（Bootstrap Modal API）
// ---------------------------------------------------------------------------
let _modal: any = null;   // bootstrap.Modal 实例

function getModal() {
  if (!_modal) _modal = new bootstrap.Modal(document.getElementById("mainModal"));
  return _modal;
}

/**
 * 通用弹窗：把 bodyHTML 放进 Bootstrap Modal 的 modal-body
 * @param bodyHTML    要放进 modal-body 的 HTML
 * @param title       顶部标题（可选）
 * @param headerRight 标题右侧、× 左边的自定义 HTML（可选，比如下载按钮）
 * @param size        弹窗尺寸：'sm' | '' (默认 md) | 'lg' | 'xl' | 'picker' (自定义 680px)
 */
function openModal(bodyHTML: string, title = "", headerRight = "", size: "sm" | "" | "lg" | "xl" | "picker" = "lg") {
  // 清理 footer + header 右侧残留
  $("modal-footer").innerHTML = "";
  const dialog = document.getElementById("modal-dialog")!;
  const header = document.getElementById("modal-header")!;
  const oldRight = header.querySelector(".header-right");
  if (oldRight) oldRight.remove();

  // 动态切换尺寸 class
  dialog.classList.remove("modal-sm", "modal-lg", "modal-xl", "modal-dialog-scrollable", "modal-confirm", "modal-picker");
  if (size === "picker") {
    dialog.classList.add("modal-lg", "modal-picker");   // 用 lg 作为基础，CSS 覆盖 max-width
  } else if (size) {
    dialog.classList.add("modal-" + size);
  }

  // 填充 header title
  const btnClose = header.querySelector(".btn-close")!;
  if (title) {
    let h5 = header.querySelector(".modal-title") as HTMLElement | null;
    if (!h5) {
      h5 = document.createElement("h5");
      h5.className = "modal-title w-100 text-center m-0";
      header.insertBefore(h5, btnClose);
    }
    h5.textContent = title;
  } else {
    const h5 = header.querySelector(".modal-title");
    if (h5) h5.remove();
  }

  // 标题右侧自定义内容（插在 × 按钮前面）
  if (headerRight) {
    const wrap = document.createElement("div");
    wrap.className = "header-right me-2";
    wrap.innerHTML = headerRight;
    header.insertBefore(wrap, btnClose);
  }

  $("modal-body").innerHTML = bodyHTML;
  getModal().show();
}

function closeModal() {
  if (S.flashing) return;
  getModal().hide();
}

/** 单选列表弹窗 */
function radioModal(
  title: string,
  desc: string,
  items: Array<{ raw: any; title: string; sub?: string; tag?: string }>,
  okText: string,
  onPick: (raw: any) => void
) {
  openModal(
    (desc ? `<div class="text-muted small text-center mb-3">${desc}</div>` : "") +
    `<div id="mlist">` +
      items
        .map(
          (it, i) =>
            `<label class="radio-row" data-i="${i}">` +
              `<input type="radio" class="form-check-input" name="pk">` +
              `<span><span class="t">${it.title}</span>` +
              (it.sub ? `<span class="s">${it.sub}</span>` : "") +
              `</span>` +
              (it.tag ? `<span class="r">${it.tag}</span>` : "") +
            `</label>`
        )
        .join("") +
    `</div>`,
    title
  );
  // 按钮放到 footer
  const footer = $("modal-footer");
  footer.innerHTML = `<button class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                      <button class="btn btn-primary" id="mok" disabled>${okText}</button>`;

  let picked = -1;
  const mlist = document.getElementById("mlist")!;
  mlist.querySelectorAll(".radio-row").forEach((r) => {
    r.addEventListener("click", () => {
      mlist.querySelectorAll(".radio-row").forEach((o) => o.classList.remove("on"));
      r.classList.add("on");
      (r.querySelector("input") as HTMLInputElement).checked = true;
      picked = +(r as HTMLElement).dataset.i!;
      (footer.querySelector("#mok") as HTMLButtonElement).disabled = false;
    });
  });
  (footer.querySelector("#mok") as HTMLButtonElement).onclick = () => {
    if (picked >= 0) {
      closeModal();
      onPick(items[picked].raw);
    }
  };
}

/** 确认弹窗（单按钮，560px 宽，底部居中） */
function confirmModal(
  title: string,
  html: string,
  okText: string,
  onOk: () => void
) {
  openModal(
    `<div class="text-center mb-3" style="font-size:28px">⚠️</div>` +
    `<div class="text-center text-muted" style="font-size:13px;line-height:1.7">${html}</div>`,
    title,
    "",
    ""   // 不传 size，用默认 modal-md + modal-confirm 类自己控制 560px
  );
  // openModal 里会清理 modal-confirm，在这里加回来
  const dialog = document.getElementById("modal-dialog")!;
  dialog.classList.add("modal-confirm");

  const footer = $("modal-footer");
  footer.innerHTML = `<button class="btn btn-primary" id="mok">${okText}</button>`;
  (footer.querySelector("#mok") as HTMLButtonElement).onclick = () => { closeModal(); onOk(); };
}

// ---------------------------------------------------------------------------
// ① 连接串口 + esptool-js main()
// ---------------------------------------------------------------------------
$("btn-1").addEventListener("click", async () => {
  // 点"连接"按钮 → 先关掉所有完成/进度状态（不管后面连接成功与否）
  showStatus("text");
  ($("wiz-text") as HTMLElement).innerHTML =
    "请将你的<b>设备</b>插入 USB 接口，<br>然后点击<b>连接</b>按钮继续。";

  if (!("serial" in (globalThis as any).navigator)) {
    setFoot("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。");
    return;
  }
  if (S.esploader) {
    // 已连接，执行断开（用户主动点 btn-1 或点 label-1 里的断开链接都会进这里）
    await disconnect();
    showStatus("text");
    goto(1);
    setLabel(1, "");
    setLabel(2, "");
    setLabel(3, "");
    setFoot("");
    return;
  }

  try {
    setFoot("正在请求串口权限…");
    if (CONFIG.LOG_WINDOW) logBox.classList.add("show");

    // requestPort 必须留在 click 同步栈里
    S.port = await serialLib.requestPort({});
    logInfo("已获取串口，正在打开传输层…");

    S.transport = new Transport(S.port, true);

    // 默认用 115200 打开，main() 过程中会自动握手
    const flashOptions: LoaderOptions = {
      transport: S.transport,
      baudrate: 115200,
      terminal: esptoolTerminal as any,
    };
    S.esploader = new ESPLoader(flashOptions);

    S.chip = await S.esploader.main();
    logOk(`✅ 识别芯片：${S.chip}`);

    // 握手必须用 115200，成功后切到用户选的波特率烧录
    if (S.baudRate !== 115200) {
      try {
        (S.esploader as any).baudrate = S.baudRate;  // 绕过 private
        await S.esploader.changeBaud();              // 发 CHANGE_BAUDRATE + 重连串口
        logInfo(`烧录波特率切换为 ${S.baudRate}`);
      } catch (e: any) {
        logWarn(`波特率切换失败（${e?.message || e}），仍用 115200 烧录`);
        (S.esploader as any).baudrate = 115200;
      }
    }

    // MAC / Flash 不再读取（用户不需要看见底层参数，烧录时自动处理）

    onConnected();
  } catch (e: any) {
    logErr("❌ 连接失败：" + (e.message || e.name));
    if (e.name === "SecurityError" || e.name === "NotAllowedError") {
      setFoot("串口权限被浏览器拦截。若你是在 iframe 里打开本页，请改为新窗口直接打开。");
    } else if (e.name !== "NotFoundError") {
      setFoot("连接失败：" + (e.message || e.name));
    }
    await disconnect();
  }
});

async function disconnect() {
  try {
    if (S.transport) await S.transport.disconnect();
  } catch { /* ignore */ }
  S.port = null;
  S.transport = null;
  S.esploader = null;
  S.chip = null;
  S.chipMac = null;
  S.chipFlash = null;

  // 只恢复按钮显示，不碰 showStatus / goto（调用方自己决定状态）
  const b1 = $("btn-1") as HTMLButtonElement;
  b1.textContent = "连接";
  b1.disabled = false;
  b1.classList.remove("ghost", "link");
  b1.style.display = "";
  const b2 = $("btn-2") as HTMLButtonElement;
  b2.style.display = "none";
  b2.classList.remove("link");
  const b3 = $("btn-3") as HTMLButtonElement;
  b3.style.display = "none";
  ($("ci-card") as HTMLElement).style.display = "none";
}

function onConnected() {
  const info = S.port?.getInfo?.() || {};
  const usb = info.usbProductId
    ? ` · USB ID ${info.usbVendorId}:${info.usbProductId}`
    : "";

  setLabel(
    1,
    `<b>${S.chip}</b> · USB ID ${info.usbVendorId || "?"}:${info.usbProductId || "?"}<br>` +
      `<a class="link" id="reconnect">断开 / 其他设备 ›</a>`
  );
  ($("reconnect") as HTMLElement).addEventListener("click", async () => {
    await disconnect();
    // 主动断开 → 回到初始状态
    showStatus("text");
    goto(1);
    setLabel(1, "");
    setLabel(2, "");
    setLabel(3, "");
    setFoot("");
  });

  // btn-1 隐藏（label-1 里的"断开 / 其他设备"链接已经覆盖了断开功能）
  ($("btn-1") as HTMLButtonElement).style.display = "none";

  // 设备已连接 → 状态区显示引导用户选择
  showStatus("text");
  ($("wiz-text") as HTMLElement).innerHTML =
    "请选择设备型号、固件版本和波特率。";



  goto(2);
  setLabel(2, "请在下方列表中选择你的 WLED 型号");

  // 显示 btn-2（选择）彩色，btn-3 保持隐藏
  const b2 = $("btn-2") as HTMLButtonElement;
  b2.textContent = "选择";
  b2.style.display = "";        // 显示
  b2.classList.remove("link");   // 不是链接样式
  b2.classList.remove("ghost"); // 主按钮彩色
  b2.disabled = false;
  // btn-3 继续隐藏

  setFoot("");
}

// ---------------------------------------------------------------------------
// ② 选型号 + 选固件 —— 合并成一个两列联动弹窗
// ---------------------------------------------------------------------------
$("btn-2").addEventListener("click", async () => {
  // 打开型号选择弹窗 → 回到文字状态
  showStatus("text");

  // 先确保 meta + release 索引已拉取
  if (!S.release) {
    try {
      // 先拉 meta 填充型号列表（如果还没的话）
      if (!WLED_MODELS.length) {
        const meta = await fetchMetaIndex();
        setModels(meta.models);
      }
      S.release = await fetchReleaseIndex();
    } catch (e: any) {
      openModal(
        `<div class="text-center text-danger mb-2">无法从远程仓库拉取版本信息</div>` +
        `<div class="text-center text-muted small">${e.message}</div>`,
        "加载固件库失败"
      );
      return;
    }
  }

  const PICKER_H = "200px";

  // 型号按 chip 分组排序，让同芯片型号排在一起
  const chips = Array.from(new Set(WLED_MODELS.map((m) => m.chip)));
  const sortedModels = [...WLED_MODELS].sort(
    (a, b) => chips.indexOf(a.chip) - chips.indexOf(b.chip) || a.flashMb - b.flashMb
  );

  let mOn: WledModel | null = S.model;
  let pOn: RemoteBinVersion | null = S.pickedVersion;
  let bOn = S.baudRate || 115200;

  const BAUD_OPTIONS = [
    { v: 115200,  label: "115200", tip: "保守 · 最稳" },
    { v: 460800,  label: "460800", tip: "推荐 · 快 4×" },
    { v: 921600,  label: "921600", tip: "极速 · 可能不稳" },
  ];

  openModal(
    // `<div class="text-center text-muted small mb-3">先选择你的板卡型号、固件版本，再挑选烧录波特率</div>` +
    `<div style="display:flex;gap:0;border:1px solid #eee;border-radius:8px;overflow:hidden;background:#fff;height:${PICKER_H}">` +
      `<div style="flex:1.2;min-width:0;border-right:1px solid #eee;display:flex;flex-direction:column">` +
        `<div style="font-size:11px;letter-spacing:1px;color:#aaa;text-align:center;padding:9px 0;border-bottom:1px solid #eee;background:#fcfcfc">型号</div>` +
        `<div id="c1list" style="flex:1;overflow:auto"></div>` +
      `</div>` +
      `<div style="flex:1.0;min-width:0;border-right:1px solid #eee;display:flex;flex-direction:column">` +
        `<div style="font-size:11px;letter-spacing:1px;color:#aaa;text-align:center;padding:9px 0;border-bottom:1px solid #eee;background:#fcfcfc">固件版本</div>` +
        `<div id="c2list" style="flex:1;overflow:auto"></div>` +
      `</div>` +
      `<div style="flex:0 0 160px;min-width:0;display:flex;flex-direction:column">` +
        `<div style="font-size:11px;letter-spacing:1px;color:#aaa;text-align:center;padding:9px 0;border-bottom:1px solid #eee;background:#fcfcfc">波特率</div>` +
        `<div id="c3list" style="flex:1;overflow:auto"></div>` +
      `</div>` +
    `</div>` +
    `<div id="pick-footer" style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:#666"></div>`,
    "选择型号与固件",
    "",
    "picker"
  );
  // 确认按钮放到 footer
  $("modal-footer").innerHTML =
    `<button class="btn btn-primary" id="mok" disabled>确认</button>`;

  // --- 渲染型号列 ---
  function renderC1() {
    const $c1 = $("c1list") as HTMLElement;
    $c1.innerHTML = sortedModels
      .map(
        (m, i) =>
          `<div class="pick-item${mOn?.id === m.id ? " on" : ""}" data-i="${i}">` +
            `<div class="pi-name">${m.name}</div>` +
            `<div class="pi-sub">${CHIP_LABEL[m.chip] || m.chip} · ${m.flashMb}MB</div>` +
          `</div>`
      )
      .join("");
    $c1.querySelectorAll(".pick-item").forEach((el) => {
      el.addEventListener("click", () => {
        mOn = sortedModels[+(el as HTMLElement).dataset.i!];
        pOn = null;
        renderC1(); renderC2(); renderFooter();
      });
    });
  }

  // --- 渲染版本号列 ---
  function renderC2() {
    const $c2 = $("c2list") as HTMLElement;
    if (!mOn || !S.release) {
      $c2.innerHTML = `<div class="empty" style="padding:30px 10px;color:#bbb;text-align:center;font-size:13px">请先选择型号</div>`;
      return;
    }
    const all = getBinVersions(S.release, mOn.bin);
    if (!all.length) {
      $c2.innerHTML = `<div class="empty" style="padding:30px 10px;color:#bbb;text-align:center;font-size:13px">该型号暂无固件<br><small style="color:#ccc">固件包：${mOn.bin}</small></div>`;
      return;
    }

    // 分组：stable 置顶
    const stable = all.filter((v) => v.channel === "stable");
    const beta = all.filter((v) => v.channel === "beta");
    const rows: string[] = [];
    let idx = 0;

    function groupTitle(title: string, count: number) {
      return `<div style="padding:8px 12px 4px;font-size:11px;color:#aaa;background:#fafafa;letter-spacing:1px;border-bottom:1px solid #f0f0f0">${title} (${count})</div>`;
    }

    if (stable.length) {
      rows.push(groupTitle("稳定版", stable.length));
      stable.forEach((v, i) => {
        const isLatest = i === 0;
        rows.push(
          `<div class="pick-item${pOn?.version === v.version && pOn?.channel === v.channel ? " on" : ""}" data-idx="${idx}" style="padding:10px 12px;border-bottom:1px solid #f4f4f4;cursor:pointer;transition:.15s;background:#fff" onmouseover="this.style.background='#fafafa'" onmouseout="this.style.background=''">` +
            `<div style="display:flex;align-items:center;gap:8px">` +
              `<span style="font-weight:600">${v.version}</span>` +
              `<span style="font-size:11px;color:#999">${fmtSize(v.size)}</span>` +
              (isLatest ? `<span style="margin-left:auto;font-size:10px;color:#fff;background:var(--brand);padding:1px 6px;border-radius:3px">最新</span>` : "") +
            `</div>` +
          `</div>`
        );
        idx++;
      });
    }
    if (beta.length) {
      rows.push(groupTitle("预发布 Beta", beta.length));
      beta.forEach((v) => {
        rows.push(
          `<div class="pick-item${pOn?.version === v.version && pOn?.channel === v.channel ? " on" : ""}" data-idx="${idx}" style="padding:10px 12px;border-bottom:1px solid #f4f4f4;cursor:pointer;transition:.15s;background:#fff" onmouseover="this.style.background='#fafafa'" onmouseout="this.style.background=''">` +
            `<div style="display:flex;align-items:center;gap:8px">` +
              `<span style="font-weight:600">${v.version}</span>` +
              `<span style="font-size:11px;color:#999">${fmtSize(v.size)}</span>` +
              `<span style="margin-left:auto;font-size:10px;color:#fff;background:#f08a24;padding:1px 6px;border-radius:3px">Beta</span>` +
            `</div>` +
          `</div>`
        );
        idx++;
      });
    }

    $c2.innerHTML = rows.join("");
    const flat = [...stable, ...beta];
    $c2.querySelectorAll(".pick-item").forEach((el) => {
      el.addEventListener("click", () => {
        ($c2 as HTMLElement).querySelectorAll(".pick-item").forEach((o) => o.classList.remove("on"));
        el.classList.add("on");
        pOn = flat[+(el as HTMLElement).dataset.idx!];
        renderFooter();
      });
    });
  }

  // --- 渲染波特率列 ---
  function renderC3() {
    const $c3 = $("c3list") as HTMLElement;
    $c3.innerHTML = BAUD_OPTIONS.map((b) => {
      const active = bOn === b.v;
      return (
        `<div class="pick-item${active ? " on" : ""}" data-v="${b.v}" style="padding:12px;border-bottom:1px solid #f4f4f4;cursor:pointer;transition:.15s;background:${active ? "var(--brand-soft)" : "#fff"}" onmouseover="if(!this.classList.contains('on'))this.style.background='#fafafa'" onmouseout="if(!this.classList.contains('on'))this.style.background=''">` +
          `<div style="font-weight:600;font-size:13px;color:${active ? "var(--brand-deep)" : "#333"}">${b.label}</div>` +
          `<div style="font-size:10px;color:#888;margin-top:2px">${b.tip}</div>` +
        `</div>`
      );
    }).join("");
    $c3.querySelectorAll(".pick-item").forEach((el) => {
      el.addEventListener("click", () => {
        bOn = +(el as HTMLElement).dataset.v!;
        renderC3();
        renderFooter();
      });
    });
  }

  // --- 渲染底部信息 + 确认按钮 ---
  function renderFooter() {
    const $ft = $("pick-footer") as HTMLElement;
    const $ok = $("mok") as HTMLButtonElement;
    if (!mOn || !pOn) {
      $ft.innerHTML = `<span style="color:#bbb">${!mOn ? "请选择型号" : "请选择固件版本"}</span>`;
      $ok.disabled = true;
      return;
    }
    const fwName = `${mOn.bin}_${pOn.version}.bin`;
    $ft.innerHTML =
      `<span style="color:#333;font-weight:600">${mOn.name}</span>` +
      `<span style="color:#888">→</span>` +
      `<span style="color:var(--brand);font-weight:600">${pOn.version}</span>` +
      `<span style="color:#888">·</span>` +
      `<span style="color:#f08a24;font-weight:600">波特率 ${bOn}</span>` +
      `<span style="color:#aaa;font-family:Consolas,monospace;margin-left:auto">${fwName} · ${fmtSize(pOn.size)}</span>`;
    $ok.disabled = false;
  }

  renderC1();
  renderC2();
  renderC3();
  renderFooter();

  ($("mok") as HTMLButtonElement).onclick = async () => {
    if (!mOn || !pOn) return;
    closeModal();
    S.model = mOn;
    S.pickedVersion = pOn;
    S.baudRate = bOn;

    // 设备已连接且波特率变了 → 立刻切换
    if (S.esploader && bOn !== 115200) {
      try {
        (S.esploader as any).baudrate = bOn;
        await S.esploader.changeBaud();
        logInfo(`✅ 波特率切换为 ${bOn}`);
      } catch (e: any) {
        logWarn(`波特率切换失败，烧录时可能用 115200：${e?.message || e}`);
      }
    } else if (S.esploader && bOn === 115200) {
      try {
        (S.esploader as any).baudrate = 115200;
        await S.esploader.changeBaud();
      } catch { /* ignore */ }
    }

    onModelAndFirmwarePicked();
  };
});

/** 型号 + 固件一起选中后的回调 */
function onModelAndFirmwarePicked() {
  const m = S.model!;
  const p = S.pickedVersion!;
  const fwName = `${m.bin}_${p.version}.bin`;

  // 状态区：提示已选择完成，可以开始烧录
  showStatus("text");
  ($("wiz-text") as HTMLElement).innerHTML =
    `已选择 <b>${m.name}</b> → <b>${p.version}</b> · 波特率 <b>${S.baudRate}</b>，点击<b>烧录</b>开始。`;

  goto(3);
  setLabel(
    2,
    `<b>当前设备：</b><br>${m.name}<br><small>${m.chip} · ${m.note}</small><br>` +
      `<a class="link" id="chg-model">更换型号/固件 ›</a>`
  );
  ($("chg-model") as HTMLElement).addEventListener("click", () => ($("btn-2") as HTMLButtonElement).click());

  // btn-2 选完就隐藏（左侧 label-2 里的"更换型号/固件"链接已经覆盖了更改功能）
  const b2 = $("btn-2") as HTMLButtonElement;
  b2.style.display = "none";

  // label-3 只显示"升级到"，去掉重复的"更换固件"链接
  // setLabel(
  //   3,
  //   `<b>升级到：</b><br>${p.version} · ${fwName}<br><small>波特率 ${S.baudRate} · ${fmtSize(p.size)}</small>`
  // );

  // btn-3 显示出来，彩色可点击
  const b3 = $("btn-3") as HTMLButtonElement;
  b3.style.display = "";
  b3.disabled = false;
}

// 保存原始的 btn-2 显示状态，finishOk 时恢复
const btn2OrigText = "选择";

// ---------------------------------------------------------------------------
// ③→④ 烧录确认 → 拉固件 → esploader.writeFlash
// ---------------------------------------------------------------------------
$("btn-3").addEventListener("click", () => {
  if (!S.pickedVersion) return;
  const p = S.pickedVersion;
  const fwName = `${S.model!.bin}_${p.version}.bin`;

  confirmModal(
    "警告",
    "烧录此固件将<b>擦除设备上的原有固件</b>，用户数据可能丢失，请谨慎操作<br><br>" +
      `<b>${S.model!.name}</b> → <b>${p.version}</b><br>` +
      `固件：${fwName} (${fmtSize(p.size)})<br>` +
      "请在烧录过程中不要拔出设备或关闭浏览器。",
    "继续",
    startFlashing
  );
});

async function startFlashing() {
  const m = S.model!;
  const p = S.pickedVersion!;
  S.flashing = true;

  ($("btn-1") as HTMLButtonElement).disabled = true;
  ($("btn-2") as HTMLButtonElement).disabled = true;
  ($("btn-3") as HTMLButtonElement).disabled = true;

  // 显示进度条
  showStatus("flash");
  setPhase("准备中…");
  setProgress(0);
  if (CONFIG.LOG_WINDOW) logBox.classList.add("show");
  logWarn(`==== 开始烧录 ====`);
  logInfo(`目标：${m.name} → ${p.version}`);
  logInfo(`芯片：${m.chip} · Flash ${m.flashMb}MB · 固件包：${m.bin}`);

  S.t0 = Date.now();
  _etaBuffer.length = 0;   // 清空 ETA 平滑缓冲
  S.timer = window.setInterval(tickEta, 1000);

  try {
    // ---- 1) 双源竞速拉固件 ----
    setPhase("正在下载固件…");
    let last = 0;
    const buf = await raceFetchFirmware(p, (loaded, total) => {
      if (total) {
        const pct = Math.round((loaded / total) * 100);
        if (pct !== last) {
          last = pct;
          setProgress(Math.floor(pct / 2));  // 下载占前半段进度
        }
      }
    });
    const data = new Uint8Array(buf);
    logOk(`固件下载完成，${fmtSize(data.length)} · 来源竞速（GitHub vs Gitee）`);

    // ---- 2) esptool-js 烧录 ----
    const offset = p.factory ? 0 : 0x10000;
    setPhase("正在擦除并写入…");

    const flashOptions: FlashOptions = {
      fileArray: [{ data, address: offset }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,         // 保留 NVS 参数（WiFi 配置、绑定 token 等），仅擦写固件覆盖扇区
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        const pct = Math.round((written / total) * 100);
        setProgress(50 + Math.floor(pct / 2));  // 烧录占后半段
        // 不再 setPhase，让 tickEta 每秒统一更新倒计时
      },
      calculateMD5Hash: (image: Uint8Array) => {
        const latin1 = Array.from(image, (b) => String.fromCharCode(b)).join("");
        return CryptoJS.MD5(CryptoJS.enc.Latin1.parse(latin1)).toString();
      },
    };

    await S.esploader!.writeFlash(flashOptions);
    await S.esploader!.after(); // reset

    setProgress(100);
    finishOk();
  } catch (e: any) {
    logErr("❌ 烧录失败：" + (e.message || e));
    finishErr((e.message || String(e)) as string);
  }
}

function setPhase(t: string) { ($("p-tip") as HTMLElement).textContent = t; }
function setProgress(p: number) {
  const pct = Math.max(0, Math.min(100, p));
  const bar = $("p-fill") as HTMLElement;
  bar.style.width = pct + "%";
  bar.setAttribute("aria-valuenow", String(Math.round(pct)));
}
// ETA 平滑：存最近 8 次 tick 的剩余秒数，取中位数显示（避免下载/写入切换时剧烈抖动）
const _etaBuffer: number[] = [];

function tickEta() {
  const w = parseFloat(($("p-fill") as HTMLElement).style.width) || 0;
  if (w < 2) return;   // 刚开始不稳定，不算

  const elapsed = (Date.now() - S.t0) / 1000;
  const eta = (elapsed / w) * (100 - w);

  _etaBuffer.push(eta);
  if (_etaBuffer.length > 8) _etaBuffer.shift();

  // 中位数过滤极端值
  const sorted = [..._etaBuffer].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const stableEta = sorted.length >= 4
    ? sorted[mid]
    : eta;

  const bounded = Math.max(1, Math.min(stableEta, 7200));
  const mm = String(Math.floor(bounded / 60)).padStart(2, "0");
  const ss = String(Math.max(0, Math.floor(bounded % 60))).padStart(2, "0");
  const label = w <= 50 ? "正在下载固件" : "正在写入固件";
  setPhase(`${label}，预计剩余 ${mm}:${ss}`);
}

function finishOk() {
  clearInterval(S.timer!);
  S.flashing = false;
  logOk("==== 烧录完成 ====");

  // 显示完成勾圈
  showStatus("done");

  // 主动断开 USB 连接（烧录完成让设备重启到新固件，Web Serial 连接自动断开）
  try { disconnect(); } catch { /* ignore */ }

  // 重置向导状态：step-1 回到 current 彩色，label-1 恢复初始提示
  S.model = null;
  S.pickedVersion = null;
  S.baudRate = 115200;
  goto(1);
  setLabel(1, "");
  setLabel(2, "");
  setLabel(3, "");

  // 按钮恢复初始状态
  const b1 = $("btn-1") as HTMLButtonElement;
  b1.textContent = "连接";
  b1.disabled = false;
  b1.classList.remove("ghost");
  b1.onclick = null;
  const b2 = $("btn-2") as HTMLButtonElement;
  b2.style.display = "none";
  const b3 = $("btn-3") as HTMLButtonElement;
  b3.style.display = "none";

  // 连接成功时（btn-1 click）自动隐藏 done-box
  const origClick = b1.onclick;  // null
  // 不做 override，onConnected 里的代码已经会隐藏 done-box

  // setFoot("烧录完成！请等待设备重启后，可继续烧录下一台设备。");
}

function finishErr(msg: string) {
  clearInterval(S.timer!);
  S.flashing = false;
  logErr("❌ 烧录失败：" + msg);

  // 烧录失败 → 重置页面（showStatus("text") 由 resetAll 内部调）
  resetAll();

  setTimeout(() => {
    openModal(
      `<div class="text-center text-danger-emphasis mb-2" style="font-size:24px">❌ 烧录失败</div>` +
      `<div class="text-center text-muted small">${msg}</div>` +
      `<div class="mt-3 small text-muted">请检查：<br>· USB 线是否稳定<br>· 设备是否被拔出<br>· 波特率是否过高（建议 115200 重试）</div>`,
      "烧录失败"
    );
    $("modal-footer").innerHTML = `<button class="btn btn-primary" data-bs-dismiss="modal">确定</button>`;
  }, 200);
}

/** 重置页面到初始未连接状态（三步向导重置 + 按钮清空 + 弹窗隐藏） */
async function resetAll() {
  try { await disconnect(); } catch { /* ignore */ }
  S.model = null;
  S.pickedVersion = null;
  S.flashing = false;
  clearInterval(S.timer!);

  // 隐藏完成/进度
  showStatus("text");

  // 重置三步向导
  goto(0);
  ($("wiz-text") as HTMLElement).innerHTML =
    "请将你的<b>设备</b>插入 USB 接口，<br>然后点击<b>连接</b>按钮继续。";
  setLabel(1, "");
  ($("ci-card") as HTMLElement).style.display = "none";

  // 按钮恢复初始
  const b1 = $("btn-1") as HTMLButtonElement;
  b1.textContent = "连接";
  b1.disabled = false;
  b1.classList.remove("ghost");
  b1.style.display = "";   // ← 恢复显示（onConnected 里隐藏过）
  const b2 = $("btn-2") as HTMLButtonElement;
  b2.style.display = "none";
  const b3 = $("btn-3") as HTMLButtonElement;
  b3.style.display = "none";

  setFoot("");
}

// 烧录中防误关
window.addEventListener("beforeunload", (e) => {
  if (S.flashing) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// 清屏
$("btnClr").addEventListener("click", () => { logEl.innerHTML = ""; });

// ---------------------------------------------------------------------------
// 右上角三个图标按钮
// ---------------------------------------------------------------------------

/** Forum 按钮 → 跳转 */
$("btn-forum").addEventListener("click", () => {
  window.open("https://kno.wled.ge/basics/getting-started/", "_blank");
});

/** Log 按钮 → JSZip 打包下载 */
$("btn-log").addEventListener("click", async () => {
  if (!logLines.length) {
    openModal(
      `<div class="text-center text-muted small">当前没有烧录日志可打包。<br>请先连接设备或执行烧录操作。</div>`,
      "下载日志"
    );
    $("modal-footer").innerHTML = `<button class="btn btn-primary" data-bs-dismiss="modal">确定</button>`;
    return;
  }

  const zip = new JSZip();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = new Date();
  const stamp =
    `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_` +
    `${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;

  // 1) 纯文本日志
  const levelMap: Record<string, string> = {
    tm: "", ti: "[INFO] ", ts: "[OK] ", te: "[ERR] ", tw: "[WARN] ",
  };
  const logTxt = logLines
    .map((l) => {
      const d = new Date(l.ts);
      const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
                String(d.getMilliseconds()).padStart(3, "0");
      return `${t} ${levelMap[l.level] || ""}${l.msg}`;
    })
    .join("\n");
  zip.file(`flasher_log_${stamp}.txt`, logTxt);

  // 2) 设备信息 JSON
  const infoJson = JSON.stringify({
    timestamp: new Date().toISOString(),
    chip: S.chip,
    mac: S.chipMac,
    flashSize: S.chipFlash,
    modelId: S.model?.id || null,
    modelName: S.model?.name || null,
    firmwareUrl: S.pickedVersion ? `${S.pickedVersion.url_github} | ${S.pickedVersion.url_gitee}` : null,
    firmwareVersion: S.pickedVersion?.version || null,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  }, null, 2);
  zip.file("device_info.json", infoJson);

  // 3) README
  const readme =
    "WLED Web Flash — Debug Log Package\n" +
    "===================================\n\n" +
    `Generated: ${new Date().toISOString()}\n` +
    `Chip: ${S.chip || "N/A"}\n` +
    `Model: ${S.model?.name || "N/A"}\n` +
    `Firmware: ${S.pickedVersion?.version || "N/A"}\n\n` +
    "If you are having problems with flashing, please:\n" +
    "  1. Ensure you are using the latest Chrome or Edge browser\n" +
    "  2. Disconnect and reconnect the USB device\n" +
    "  3. Check that your device is in bootloader mode\n" +
    "  4. Submit this log zip to https://kno.wled.ge/basics/getting-started/ for further help\n";
  zip.file("README.txt", readme);

  // 4) 下载
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `flasher_log_${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

/** Firmware 按钮 → 两列联动下载弹窗（型号 + 版本号，仅 stable） */
$("btn-fw").addEventListener("click", () => {
  openFirmwareDownloadModal();
});

async function openFirmwareDownloadModal() {
  try {
    if (!WLED_MODELS.length) {
      const meta = await fetchMetaIndex();
      setModels(meta.models);
    }
    if (!S.release) S.release = await fetchReleaseIndex();
  } catch (e: any) {
    openModal(
      `<div class="text-center text-danger mb-2">远程版本拉取失败</div>` +
      `<div class="text-center text-muted small">${e.message}</div>`,
      "固件库"
    );
    $("modal-footer").innerHTML = `<button class="btn btn-primary" data-bs-dismiss="modal">确定</button>`;
    return;
  }

  let mOn: WledModel | null = null;                       // 选中的型号
  let vOn: RemoteBinVersion | null = null;                // 选中的版本（stable）

  openModal(
    `<div class="picker3" style="height:340px">` +
      `<div class="col c1"><div class="hd">型号</div><div id="fwMlist"></div></div>` +
      `<div class="col c2"><div class="hd">版本号（稳定版）</div><div id="fwVlist"></div></div>` +
    `</div>` +
    `<div id="fwHint" style="margin-top:10px;font-size:12px;color:#888;min-height:16px;text-align:right">请选择型号和版本</div>`,
    "选择固件",
    `<button class="btn btn-primary btn-sm" id="fwdl" disabled>下载</button>`
  );
  // footer 清空（下载按钮已移到标题栏右侧）
  $("modal-footer").innerHTML = "";

  // --- 渲染型号列 ---
  function renderM() {
    ($("fwMlist") as HTMLElement).innerHTML = WLED_MODELS.map((m, i) => {
      const stableCount = S.release ? getBinVersions(S.release, m.bin, "stable").length : 0;
      const disabled = stableCount === 0;
      return `<div class="it${mOn?.id === m.id ? " on" : ""}" data-i="${i}"${disabled ? ' style="color:#bbb;cursor:not-allowed"' : ""}>` +
        `<span>${m.name}</span>` +
        (stableCount ? `<span style="font-size:11px;color:#aaa;margin-left:auto">${stableCount}版</span><span class="arr">›</span>` : `<span style="margin-left:auto;color:#ddd">—</span>`) +
      `</div>`;
    }).join("");
    ($("fwMlist") as HTMLElement).querySelectorAll(".it").forEach((el) => {
      if ((el as HTMLElement).style.cursor === "not-allowed") return;
      el.addEventListener("click", () => {
        mOn = WLED_MODELS[+(el as HTMLElement).dataset.i!];
        vOn = null;
        renderM(); renderV(); renderBar();
      });
    });
  }

  // --- 渲染版本列（仅 stable） ---
  function renderV() {
    const c2 = $("fwVlist") as HTMLElement;
    if (!mOn || !S.release) {
      c2.innerHTML = `<div class="empty">请先选择型号</div>`;
      return;
    }
    const list = getBinVersions(S.release, mOn.bin, "stable");
    if (!list.length) {
      c2.innerHTML = `<div class="empty">该型号暂无稳定版固件</div>`;
      return;
    }
    c2.innerHTML = list.map((v, i) => {
      const isLatest = i === 0;
      return (
        `<div class="it${vOn?.version === v.version ? " on" : ""}" data-i="${i}">` +
          `<div class="rowv">` +
            `<span class="v">${v.version}</span>` +
            (isLatest ? `<span class="tag">最新</span>` : "") +
          `</div>` +
          `<div class="d">${fmtSize(v.size)}</div>` +
        `</div>`
      );
    }).join("");
    c2.querySelectorAll(".it").forEach((el) => {
      el.addEventListener("click", () => {
        vOn = list[+(el as HTMLElement).dataset.i!];
        renderV(); renderBar();
      });
    });
  }

  // --- 右上角下载按钮状态 + 底部 hint ---
  function renderBar() {
    const dlBtn = $("fwdl") as HTMLButtonElement;
    const hint = $("fwHint") as HTMLElement;
    if (!mOn || !vOn) {
      dlBtn.disabled = true;
      hint.textContent = mOn ? "请选择版本号" : "请选择型号";
      hint.style.color = "#aaa";
      return;
    }
    // 已选好 → 启用下载按钮
    dlBtn.disabled = false;
    hint.textContent = `${mOn.name} → ${vOn.version} · ${fmtSize(vOn.size)}`;
    hint.style.color = "#666";
    dlBtn.onclick = async () => {
      if (!mOn || !vOn) return;
      dlBtn.disabled = true;
      dlBtn.textContent = "下载中...";
      hint.textContent = "正在拉取固件，请稍候…";
      try {
        const urls = [vOn.url_github, vOn.url_gitee].filter(Boolean);
        const fwName = `${mOn.bin}_${vOn.version}.bin`;
        // 竞速下载（GitHub + Gitee，谁先响用谁）
        const urlsFull = urls.map(u => u.includes("?") ? `${u}&t=${Date.now()}` : `${u}?t=${Date.now()}`);
        const controllers: AbortController[] = [];
        const tasks = urlsFull.map(u => (async () => {
          const ctrl = new AbortController(); controllers.push(ctrl);
          const resp = await fetch(u, { signal: ctrl.signal, cache: "no-store" });
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return await resp.blob();
        })());
        const blob = await Promise.any(tasks);
        controllers.forEach(c => c.abort());
        // 触发浏览器下载（用 Blob URL，不会导致空白）
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fwName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setFoot(`✅ 已触发下载：${fwName}，请查看浏览器下载项`);
        hint.textContent = `✅ ${fwName} 已发送到下载队列`;
      } catch (e: any) {
        hint.textContent = "❌ 下载失败：" + e.message;
        hint.style.color = "#e5533c";
      } finally {
        dlBtn.disabled = false;
        dlBtn.textContent = "下载";
      }
    };
  }

  renderM();
  renderV();
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
goto(1);
setLabel(1, "");
setFoot("提示：本页需使用桌面版 Chrome / Edge 打开");
logInfo("🚀 WLED Web Flash 已加载 — esptool-js + 三步向导");
