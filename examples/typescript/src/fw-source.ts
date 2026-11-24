/**
 * 固件源 —— 双源竞速 + localStorage 缓存
 * ----------------------------------------------------------------
 * 设计：
 *   - 同时请求 GitHub raw 和 Gitee raw，谁先成功用谁（Promise.any）
 *   - 30 分钟 localStorage 缓存，避免重复网络请求
 *   - 直接 fetch 远程 JSON 索引，不走 GitHub REST API（速度快 + 无限流）
 *
 * 远程仓库结构：
 *   https://github.com/jacker-25/WLED-Firmware-Collection
 *   ├── meta.json            ← 纯型号元信息（轻量，启动优先拉）
 *   ├── release.json         ← 完整索引：models + bins[bin] 版本数组
 *   ├── release_latest.json  ← 每个 bin 最新版
 *   └── firmwares/<bin>/<stable|beta>/<bin>_<version>.bin
 *
 * 每个固件条目的 url_github / url_gitee 字段已由 build_release.mjs 生成，
 * 前端下载 bin 时同样走双源竞速。
 */

// ========= 仓库配置 =========
const OWNER  = "jacker-25";
const REPO   = "WLED-Firmware-Collection";
const BRANCH = "main";

const GH_RAW    = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const GITEE_RAW = `https://gitee.com/${OWNER}/${REPO}/raw/${BRANCH}`;
// =========================

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟（推完仓库后最多等 5 分钟生效）
const CACHE_PREFIX = "fw_src_";

// ---------------------------------------------------------------------------
// 类型定义（与远程 JSON 对齐）
// ---------------------------------------------------------------------------
export interface RemoteModel {
  id: string;
  name: string;
  chip: string;
  bin: string;
  flashMb: number;
  note: string;
  series: string;
  variants?: number;
  bins?: { stable?: string[]; beta?: string[] };
}

export interface RemoteBinVersion {
  version: string;
  channel: "stable" | "beta";
  factory: boolean;
  size: number;
  checksum: string;
  description: string;
  url_github: string;
  url_gitee: string;
}

export interface ReleaseIndex {
  repo: { owner: string; repo: string; branch: string };
  updated_at: string;
  models: RemoteModel[];
  bins: Record<string, RemoteBinVersion[]>;
}

export interface MetaIndex {
  repo: { owner: string; repo: string; branch: string };
  updated_at: string;
  model_count?: number;
  bin_count?: number;
  models: RemoteModel[];
}

// ---------------------------------------------------------------------------
// 通用：双源竞速 fetcher + localStorage 缓存
// ---------------------------------------------------------------------------

/**
 * 用多个 URL 竞速，返回第一个成功的 JSON。
 * 成功后写入 localStorage 缓存，失败则回退到缓存。
 */
async function raceFetchJSON<T>(
  paths: string[],            // 相对路径，如 ["release.json", "release.json"]
  cacheKey: string
): Promise<T> {
  const cacheFullKey = CACHE_PREFIX + cacheKey;

  // 1) 尝试返回有效缓存
  try {
    const raw = localStorage.getItem(cacheFullKey);
    if (raw) {
      const c = JSON.parse(raw);
      if (c?.d && Date.now() - c.t < CACHE_TTL) return c.d as T;
    }
  } catch { /* ignore */ }

  // 2) 构造双源完整 URL + cache-buster
  const cacheBuster = `t=${Date.now()}`;
  const urls = paths.flatMap((p) => {
    const full = p.startsWith("http") ? p : `${GH_RAW}/${p}`;
    const full2 = p.startsWith("http") ? p : `${GITEE_RAW}/${p}`;
    return [
      full.includes("?") ? `${full}&${cacheBuster}` : `${full}?${cacheBuster}`,
      full2.includes("?") ? `${full2}&${cacheBuster}` : `${full2}?${cacheBuster}`,
    ];
  });

  // 3) 竞速请求（强制绕过 HTTP 缓存）
  const controllers: AbortController[] = [];
  const fetchTasks = urls.map((url) =>
    (async () => {
      const ctrl = new AbortController();
      controllers.push(ctrl);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        return { data, url };
      } catch {
        throw new Error("fetch fail: " + url);
      }
    })()
  );

  try {
    const first = await Promise.any(fetchTasks);
    // 其他还在飞的请求立即取消
    controllers.forEach((c) => c.abort());

    // 4) 写入缓存
    try {
      localStorage.setItem(cacheFullKey, JSON.stringify({ t: Date.now(), d: first.data }));
    } catch { /* 配额满就算了 */ }

    return first.data as T;
  } catch {
    // 全部失败 → 回退到旧缓存（哪怕过期）
    try {
      const raw = localStorage.getItem(cacheFullKey);
      if (raw) {
        const c = JSON.parse(raw);
        if (c?.d) {
          console.warn(`[fw-source] 网络全部失败，使用旧缓存（${cacheKey}）`);
          return c.d as T;
        }
      }
    } catch { /* ignore */ }
    throw new Error(`无法加载 ${cacheKey}（GitHub + Gitee 均不可达）`);
  }
}

/**
 * 固件文件的双源竞速下载（ArrayBuffer）。
 * 传一个 RemoteBinVersion 进来，自动用 url_github / url_gitee 竞速。
 */
export async function raceFetchFirmware(
  entry: RemoteBinVersion,
  onProgress?: (loaded: number, total: number) => void
): Promise<ArrayBuffer> {
  const ts = Date.now();
  const urls = [entry.url_github, entry.url_gitee]
    .filter(Boolean)
    .map((u) => (u.includes("?") ? `${u}&t=${ts}` : `${u}?t=${ts}`));
  if (!urls.length) throw new Error("固件 URL 为空");

  const controllers: AbortController[] = [];
  const fetchTasks = urls.map((url) =>
    (async () => {
      const ctrl = new AbortController();
      controllers.push(ctrl);
      try {
        const resp = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const total = resp.headers.get("content-length")
          ? parseInt(resp.headers.get("content-length")!, 10)
          : 0;
        const reader = resp.body!.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          onProgress?.(loaded, total);
        }
        // 合并
        const merged = new Uint8Array(loaded);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
        return merged.buffer;
      } catch (err) {
        throw err;
      }
    })()
  );

  try {
    const first = await Promise.any(fetchTasks);
    controllers.forEach((c) => c.abort());
    return first;
  } catch {
    throw new Error(`固件下载失败：${entry.version}（GitHub + Gitee 均不可达）`);
  }
}

// ---------------------------------------------------------------------------
// 索引拉取入口
// ---------------------------------------------------------------------------

/** 拉 release.json（完整索引，含 models + bins 所有版本） */
export async function fetchReleaseIndex(force = false): Promise<ReleaseIndex> {
  if (force) {
    try { localStorage.removeItem(CACHE_PREFIX + "release"); } catch { /* ignore */ }
  }
  return raceFetchJSON<ReleaseIndex>(["release.json"], "release");
}

/** 拉 meta.json（轻量型号列表，启动时可以先显示这个再后台拉完整索引） */
export async function fetchMetaIndex(force = false): Promise<MetaIndex> {
  if (force) {
    try { localStorage.removeItem(CACHE_PREFIX + "meta"); } catch { /* ignore */ }
  }
  return raceFetchJSON<MetaIndex>(["meta.json"], "meta");
}

// ---------------------------------------------------------------------------
// 便捷查询函数
// ---------------------------------------------------------------------------

/** 从 release.json 里拿到某 bin 的全部版本（按 version 倒序） */
export function getBinVersions(
  release: ReleaseIndex,
  bin: string,
  channel?: "stable" | "beta"
): RemoteBinVersion[] {
  const list = (release.bins[bin] || []).slice();
  list.sort((a, b) => versionCompare(b.version, a.version));
  if (channel) return list.filter((v) => v.channel === channel);
  return list;
}

/** 语义化版本号比较（返回正数 a>b，负数 a<b） */
export function versionCompare(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".");
  const pb = b.replace(/^v/i, "").split(".");
  for (let i = 0; i < 3; i++) {
    const na = parseInt(pa[i] || "0", 10);
    const nb = parseInt(pb[i] || "0", 10);
    if (na !== nb) return na - nb;
  }
  // beta / alpha 后缀：稳定版 > beta > alpha
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  const rank = (s: string) =>
    s.includes("alpha") ? 1 : s.includes("beta") ? 2 : s.includes("rc") ? 3 : 4;
  return rank(sa) - rank(sb);
}

/** 人类可读文件大小 */
export function fmtSize(b?: number): string {
  if (!b && b !== 0) return "";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / 1024 / 1024).toFixed(2) + " MB";
}

/** 清空所有缓存（调试用） */
export function clearCache() {
  try {
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) all.push(k);
    }
    all.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
