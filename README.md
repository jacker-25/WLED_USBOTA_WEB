# DOMRAEM WLED Web Flash

> 基于 esptool-js 的 WLED 网页 USB 升级工具 — 无需安装驱动，浏览器里直接烧录 ESP32 系列的 WLED 固件。

## 功能特性

- 🌐 **纯浏览器烧录** — 基于 Web Serial API，无需安装任何软件或驱动
- 🔌 **USB 直连** — 三步向导：连接 → 选固件 → 烧录
- 📦 **远程固件库** — 自动从 GitHub（Gitee 镜像）拉取 WLED 固件索引，支持多型号多版本
- ⚡ **多波特率** — 115200 / 460800 / 921600 可选，失败自动降级
- 📊 **实时进度** — 进度条 + ETA 倒计时，烧录完成绿色勾圈庆祝动画
- 📋 **日志导出** — 烧录日志一键打包下载为 .zip
- 🎨 **品牌主题** — DOMRAEM 青蓝主色（`#2FB8A8`），毛玻璃弹窗遮罩

## 支持的芯片

ESP32 · ESP32-S2 · ESP32-S3 · ESP32-C3 · ESP32-C6 · ESP32-H2 · ESP32-C5

## 浏览器要求

| 浏览器 | 版本 | 说明 |
|---|---|---|
| Google Chrome | ≥ 89 | 推荐 |
| Microsoft Edge | ≥ 89 | 原生支持 Web Serial |
| Google Chrome (Android) | ≥ 61 | 通过 USB OTG + web-serial-polyfill |
| Firefox / Safari | — | **不支持** Web Serial API |

---

## 用户使用指南

### 升级流程（3 步）

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Step 1     │     │  Step 2     │     │  Step 3     │
│   连接 USB   │ ──► │  选固件波特率 │ ──► │   烧录      │
└─────────────┘     └─────────────┘     └─────────────┘
```

#### Step 1 · 连接设备

1. 用 USB 线把 ESP32 开发板接到电脑
2. 打开 Chrome/Edge 浏览器访问工具页面
3. 点击 **"连接"** 按钮 → 浏览器弹出串口选择框
4. 选中你的设备 → 工具自动检测芯片型号

> 如果设备没在列表里，先检查：USB 线是否为数据线（不是纯充电线）、是否已装好 USB 转串口芯片驱动（CP210x / CH340 / FT232 等）。

#### Step 2 · 选择固件

连接成功后弹出型号选择弹窗：

| 列 | 说明 |
|---|---|
| **设备型号** | 根据实际硬件选择，如 `DOM-ETH-804DM` |
| **固件版本** | 仅显示 Stable 版本，Beta 版不列出 |
| **波特率** | 默认 921600；如果烧录不稳定可降到 460800 或 115200 |

> 💡 右上角 📄 图标打开固件库，可单独下载固件到本地烧录。右上角 📋 图标导出烧录日志，💬 图标打开论坛求助。

#### Step 3 · 开始烧录

点击 **"烧录"** 按钮，进度条实时显示：

```
████████████░░░░░░░░  63%  2m 14s
```

烧录完成后显示 ✅ 绿色勾圈，设备会自动硬重启。

---

## 开发者快速开始

### 环境要求

- Node.js ≥ 16
- npm / pnpm / yarn

### 克隆 & 安装

```bash
git clone <repo-url>
cd esptool-js

# 安装根依赖（esptool-js 核心库）
npm install

# 构建核心库（example 需要 lib 输出）
npm run build

# 进入 TypeScript 示例（本项目的主工程）
cd examples/typescript
npm install
```

### 开发模式

```powershell
# Windows PowerShell
cd "g:\htm_file\esp32_flash\esptool-js -2\examples\typescript"
npm.cmd run dev
```

Dev 服务器启动后访问：**http://localhost:1234**

> ⚠️ Windows 下 `npm.cmd` 必须加 `.cmd` 后缀，否则 PowerShell 执行策略会拦截。

### 生产构建

```powershell
cd "g:\htm_file\esp32_flash\esptool-js -2\examples\typescript"
npm.cmd run build
```

输出目录：`examples/typescript/dist/`，包含可直接部署到任意静态服务器的完整站点。

### 清理缓存

```powershell
npm.cmd run clean
```

---

## 工程结构

```
esptool-js -2/
├── src/                         # esptool-js 核心库（不改）
│   ├── esploader.ts             #   ESPLoader 主类
│   ├── webserial.ts             #   Transport（Web Serial 封装）
│   ├── reset.ts                 #   复位策略
│   ├── stubFlasher.ts           #   Stub flasher 引导
│   └── targets/                 #   各芯片 ROM/stub
│
└── examples/typescript/         # ⭐ 本项目主工程
    ├── src/
    │   ├── index.html           #   全部 CSS + HTML 模板
    │   ├── index.ts             #   主逻辑：三步向导 / 弹窗 / 烧录流程
    │   ├── models.ts            #   WledModel 接口 + setModels()
    │   ├── fw-source.ts         #   远程固件源（GitHub+Gitee 竞速拉取）
    │   └── github.ts            #   GitHub API 辅助
    ├── assets/                  #   图标、favicon
    ├── dist/                    #   构建产物
    ├── package.json
    └── tsconfig.json
```

---

## 远程固件仓库

固件索引托管在 GitHub，Gitee 镜像加速国内访问：

```
jacker-25/WLED-Firmware-Collection/
├── meta.json            # 轻量型号列表（型号 id / 名称 / 芯片 / bin 名）
├── release.json         # 完整索引（models + bins + 版本数组）
├── release_latest.json  # 仅最新 stable 版本
└── firmwares/<bin>/<stable|beta>/<bin>_<version>.bin
```

固件加载优先级：`meta.json` → `release.json`（带 5 分钟 localStorage 缓存）。

**缓存清理（浏览器 Console）：**
```js
for (const k of Object.keys(localStorage)) if (k.startsWith("fw_src_")) localStorage.removeItem(k)
```

---

## 烧录参数

```ts
const offset = p.factory ? 0 : 0x10000;  // factory 固件写 0x0，app 固件写 0x10000
eraseAll: false                           // 只擦写覆盖扇区，保留 NVS
flashMode/Freq/Size: "keep"               // 读取原 bootloader 配置
compress: true                            // 压缩传输，减少时间
```

连接握手先用 115200，成功后调用 `esploader.changeBaud()` 切到用户选的波特率，失败自动降级到 115200。

---

## 品牌色

| 变量 | 色值 | 用途 |
|---|---|---|
| `--brand` | `#2FB8A8` | DOMRAEM 青蓝主色（按钮、进度、状态文字） |
| `--brand-soft` | `#D6F1EC` | 选中/已完成状态背景 |
| `--brand-mid` | `#7DD3C8` | hover 态 |
| `--brand-deep` | `#1D8E84` | 备用深色 |

---

## 已知限制

1. **仅 Chrome/Edge** 支持 Web Serial，Firefox 和 Safari 无法使用
2. 固件库 Beta 版本暂不展示，仅提供 Stable
3. 下载固件时只有"下载中..."状态提示，暂未显示实时 KB 进度
4. Gitee 镜像仓库尚未推送，目前仅 GitHub 源可用

## 许可证

核心库 esptool-js 遵循 Apache 2.0（见 `LICENSE`），本项目定制化部分 © DOMRAEM。
