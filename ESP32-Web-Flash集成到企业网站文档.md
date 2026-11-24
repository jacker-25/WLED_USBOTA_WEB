# ESP32 Web Flash 集成文档

## 概述

本文档描述如何将 ESP32 Web 烧录功能集成到企业网站中。该功能基于 Web Serial API 实现，无需安装驱动即可在浏览器中完成 ESP32 设备的固件烧录。

---

## 一、技术栈

| 分类 | 技术 | 版本要求 |
|------|------|----------|
| 语言 | TypeScript | ^4.0 |
| 构建工具 | Parcel | ^2.0 |
| 加密库 | CryptoJS | ^4.0 |
| 浏览器 | Chrome/Edge | >= 89 |

---

## 二、核心依赖

### 2.1 Web Serial API

浏览器原生 API，用于 USB 串口通信：

- **文档**: https://developer.mozilla.org/zh-CN/docs/Web/API/Web_Serial_API
- **兼容性**: Chrome 89+, Edge 89+
- **安全要求**: 仅支持 HTTPS 环境

### 2.2 esptool-js

ESP32 官方 Web 烧录库：

```typescript
import { ESPLoader, Transport } from 'esptool-js';
```

---

## 三、集成步骤

### 3.1 安装依赖

```bash
# 进入网站项目目录
cd your-website-project

# 安装 esptool-js 和类型定义
npm install esptool-js
npm install @types/crypto-js --save-dev
```

### 3.2 引入资源

在 HTML 中引入 CryptoJS（用于 MD5 计算）：

```html
<!-- 在 <head> 中添加 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
```

### 3.3 创建烧录组件

```typescript
// esp-flash-component.ts
import { ESPLoader, Transport, FlashOptions } from 'esptool-js';

export class ESPFlashComponent {
  private container: HTMLElement;
  private esploader: ESPLoader | null = null;
  
  constructor(options: {
    container: HTMLElement;
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }) {
    this.container = options.container;
    this.render();
  }
  
  private render() {
    // 渲染烧录界面（参考 index.html）
    this.container.innerHTML = `
      <div class="esp-flash-wrapper">
        <!-- 终端显示 -->
        <div id="terminal" class="terminal"></div>
        
        <!-- 操作按钮 -->
        <button id="connectButton">连接设备</button>
        <button id="eraseButton">擦除 Flash</button>
        <button id="programButton">开始烧录</button>
        
        <!-- 进度条 -->
        <div class="progress-bar"></div>
        
        <!-- 文件选择 -->
        <input type="file" id="firmwareFile" accept=".bin">
      </div>
    `;
    this.bindEvents();
  }
  
  private async connectDevice() {
    // Web Serial API 连接逻辑
    const port = await navigator.serial.requestPort({
      filters: [
        { usbVendorId: 0x10c4 },  // Silicon Labs
        { usbVendorId: 0x0403 },  // FTDI
        { usbVendorId: 0x1a86 },  // CH340
        { usbVendorId: 0x303a },  // Espressif
      ]
    });
    
    const transport = new Transport(port, true);
    this.esploader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: this.terminal,
    });
    
    await this.esploader.connect();
  }
  
  private async flashFirmware(file: File) {
    if (!this.esploader) throw new Error('未连接设备');
    
    const arrayBuffer = await file.arrayBuffer();
    const flashOptions: FlashOptions = {
      fileArray: [{ data: new Uint8Array(arrayBuffer), address: 0x0 }],
      eraseAll: true,
      compress: true,
      flashSize: 'keep',
    };
    
    await this.esploader.writeFlash(flashOptions);
  }
}
```

---

## 四、API 接口

### 4.1 ESPLoader 核心方法

| 方法 | 说明 | 参数 |
|------|------|------|
| `connect()` | 连接设备 | 无 |
| `disconnect()` | 断开连接 | 无 |
| `eraseFlash()` | 擦除 Flash | 无 |
| `writeFlash(options)` | 烧录固件 | FlashOptions |
| `changeBaud()` | 切换波特率 | 无 |

### 4.2 FlashOptions 配置

```typescript
interface FlashOptions {
  fileArray: Array<{ data: Uint8Array; address: number }>;
  eraseAll?: boolean;      // 是否全擦除
  compress?: boolean;      // 是否压缩
  flashSize?: string;      // Flash 大小 ("keep" | "1MB" | "2MB" | "4MB")
  reportProgress?: (fileIndex, written, total) => void;
  calculateMD5Hash?: (image: Uint8Array) => string;
}
```

---

## 五、样式集成

### 5.1 基础样式

```css
.esp-flash-wrapper {
  font-family: 'Consolas', 'Monaco', monospace;
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}

.terminal {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 15px;
  height: 200px;
  overflow-y: auto;
  border-radius: 4px;
  font-size: 14px;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar > div {
  height: 100%;
  background: #4CAF50;
  transition: width 0.3s;
}

button {
  padding: 10px 20px;
  margin-right: 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

### 5.2 样式隔离建议

为避免样式冲突，建议使用 Shadow DOM 或 scoped CSS：

```typescript
// 使用 Shadow DOM
class ESPFlashElement extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>/* 组件样式 */</style>
      <div>/* 组件内容 */</div>
    `;
  }
}
customElements.define('esp-flash', ESPFlashElement);
```

---

## 六、浏览器兼容性

| 浏览器 | 版本 | 支持状态 |
|--------|------|----------|
| Google Chrome | >= 89 | ✅ 完全支持 |
| Microsoft Edge | >= 89 | ✅ 完全支持 |
| Safari | >= 15.4 | ⚠️ 部分支持 |
| Firefox | - | ❌ 不支持 |

---

## 七、安全注意事项

### 7.1 HTTPS 必需

Web Serial API 仅在安全上下文（HTTPS）中可用：

```
✅ https://your-domain.com/flash
❌ http://your-domain.com/flash
❌ file:///path/to/index.html
```

### 7.2 用户授权

每次连接设备都需要用户手动确认：

```typescript
// navigator.serial.requestPort() 必须由用户交互触发
connectButton.addEventListener('click', async () => {
  const port = await navigator.serial.requestPort();
});
```

### 7.3 设备过滤

建议限制可连接的设备类型：

```typescript
const port = await navigator.serial.requestPort({
  filters: [
    { usbVendorId: 0x303a },  // 仅允许 Espressif 设备
  ]
});
```

---

## 八、部署指南

### 8.1 开发环境

```bash
# 启动开发服务器
npm run dev

# 访问地址
http://localhost:1234
```

### 8.2 生产构建

```bash
# 构建生产版本
npm run build

# 输出目录
dist/
├── index.html
├── typescript.xxx.js
└── styles.xxx.css
```

### 8.3 静态资源托管

将构建产物部署到任意静态资源服务器：

- ✅ Nginx
- ✅ Apache
- ✅ CDN (Cloudflare, AWS CloudFront)
- ✅ Vercel / Netlify

---

## 九、常见问题

### Q1: 连接设备时提示"未找到设备"

**原因**：设备未进入烧录模式

**解决方案**：
1. 按住设备的 BOOT 按钮
2. 按下 RESET 按钮
3. 松开 BOOT 按钮
4. 重新点击"连接设备"

### Q2: 烧录速度慢

**解决方案**：
- 使用更高波特率（如 921600）
- 确保 USB 线质量良好
- 关闭浏览器调试控制台

### Q3: 浏览器不支持

**解决方案**：
- 提示用户使用 Chrome 或 Edge 浏览器
- 提供备用的桌面工具下载链接

---

## 十、技术支持

| 资源 | 链接 |
|------|------|
| esptool-js GitHub | https://github.com/espressif/esptool-js |
| Web Serial API | https://web.dev/serial/ |
| ESP32 官方文档 | https://docs.espressif.com/projects/esp-idf |

---

## 附录：完整示例代码

```html
<!DOCTYPE html>
<html>
<head>
  <title>ESP32 Web Flash</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
  <style>/* 样式 */</style>
</head>
<body>
  <div id="flash-container"></div>
  <script type="module">
    import { ESPFlashComponent } from './esp-flash-component.js';
    
    new ESPFlashComponent({
      container: document.getElementById('flash-container'),
      onComplete: () => alert('烧录完成！'),
      onError: (err) => console.error('烧录失败:', err),
    });
  </script>
</body>
</html>
```

---

**文档版本**: v1.0  
**更新日期**: 2026-06-12  
**适用项目**: esptool-js ESP32 Web Flash

## 启动命令（Windows PowerShell）

cd "g:\domraem_Software\wled_usb_ota\wledusb_ota_web\examples\typescript"
npm.cmd run dev

`npm.cmd` 是关键——PowerShell 默认拦截`npm` （执行策略限制），加`.cmd` 后缀就绕过了。

## 生产构建

cd "g:\domraem_Software\wled_usb_ota\wledusb_ota_web\examples\typescript"
npm.cmd run build

