/**
 * GitHub Releases 拉取 + localStorage 缓存 + 型号固件匹配
 * ----------------------------------------------------------------
 * ⚠️ 上线前把 REPO 改成你自家固件仓库（默认是 WLED 官方仓库）
 *    比如 const REPO = 'your-org/WLED-custom';
 *
 * 缓存策略：30 分钟 localStorage，避免 GitHub API 未登录 60 次/小时 限流。
 * 客户量大时建议改：前端只打自家后端接口 → 后端拉 release 存 KV/R2。
 */

import type { WledModel } from "./models.js";

/** ★★★ GitHub 仓库占位 ★★★ 上线前改成你自家的固件仓库 */
export const REPO = "wled/WLED";
const CACHE_KEY = "wled_releases_v2";
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟

export interface GithubAsset {
  name: string;
  url: string;
  size: number;
}

export interface GithubRelease {
  tag: string;
  name: string;
  date: string;      // yyyy-mm-dd
  prerelease: boolean;
  draft: boolean;
  body: string;
  assets: GithubAsset[];
}

export interface MatchedFirmware {
  url: string;       // 可直接 fetch 的固件 URL
  offset: number;    // 烧录偏移（factory=0，plain=0x10000）
  kind: "factory" | "app";
  name: string;
  size: number;
}

export interface ReleaseFirmwarePair {
  release: GithubRelease;
  fw: MatchedFirmware;
}

/**
 * 拉 releases（带 localStorage 缓存）
 */
export async function fetchWledReleases(force = false): Promise<GithubRelease[]> {
  if (!force) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c?.d?.length && Date.now() - c.t < CACHE_TTL) return c.d;
      }
    } catch { /* 缓存坏了就重拉 */ }
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=30`,
    { headers: { Accept: "application/vnd.github+json" } }
  );
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      "GitHub API 访问频率超限（未登录 60 次/小时）。" +
      "请稍后再试，或让管理员把 releases 缓存到自有服务器。"
    );
  }
  if (!res.ok) throw new Error("GitHub API 返回 " + res.status);

  const data = (await res.json()) as any[];
  const list: GithubRelease[] = data.map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    date: (r.published_at || r.created_at || "").slice(0, 10),
    prerelease: !!r.prerelease,
    draft: !!r.draft,
    body: (r.body || "").slice(0, 2000),
    assets: (r.assets || []).map((a: any) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  }));

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: list }));
  } catch { /* 配额满就算了 */ }
  return list;
}

/**
 * 从某个 release 里为某型号挑出可用固件。
 * 优先 factory.bin（含 bootloader+分区表，烧 0x0 不会变砖）；
 * 没有 factory 时退回普通 .bin（app 镜像，必须烧 0x10000）。
 */
export function pickFirmware(
  release: GithubRelease,
  model: WledModel
): MatchedFirmware | null {
  if (!release || !model) return null;
  const stem = `${release.tag}_${model.bin}`;

  // 1) 优先 factory（最稳）
  const factory = release.assets.find(
    (a) => a.name === `${stem}.factory.bin` || a.name === `${stem}.factory.bin.gz`
  );
  if (factory) {
    return {
      url: factory.url,
      offset: 0,
      kind: "factory",
      name: factory.name,
      size: factory.size,
    };
  }

  // 2) 退回普通 bin（app 镜像）
  const plain = release.assets.find(
    (a) => a.name === `${stem}.bin` || a.name === `${stem}.bin.gz`
  );
  if (plain) {
    return {
      url: plain.url,
      offset: 0x10000,
      kind: "app",
      name: plain.name,
      size: plain.size,
    };
  }
  return null;
}

/** 过滤出该型号真正有固件的版本 */
export function versionsForModel(
  releases: GithubRelease[],
  model: WledModel,
  includePrerelease = false
): ReleaseFirmwarePair[] {
  return releases
    .filter((r) => !r.draft && (includePrerelease || !r.prerelease))
    .map((r) => ({ release: r, fw: pickFirmware(r, model) }))
    .filter((x) => x.fw) as ReleaseFirmwarePair[];
}

/** 人类可读的文件大小 */
export function fmtSize(b?: number): string {
  if (!b && b !== 0) return "";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / 1024 / 1024).toFixed(2) + " MB";
}
