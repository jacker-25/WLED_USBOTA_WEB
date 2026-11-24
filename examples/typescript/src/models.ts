/**
 * 型号库接口定义 + 远程加载
 * ----------------------------------------------------------------
 * 型号列表现在从远程仓库 meta.json 动态拉取，本地不硬编码数据。
 * 这里只保留：
 *   - WledModel 接口（供 TypeScript 类型检查）
 *   - CHIP_LABEL 常量（芯片展示名映射，固定不变）
 *   - WLED_MODELS 空数组占位（启动时由 loadModels() 远程填充）
 */

export interface WledModel {
  id: string;
  name: string;
  chip: string;      // ESP32 / ESP32-C3 / ESP32-S2 / ESP32-S3 / ESP8266 ...
  bin: string;       // 固件目录名，如 "wled_WLE_ACLE"
  flashMb: number;   // Flash 容量（MB）
  note: string;
  series: string;    // 分组标签（"普通" / "ETH" / "Waterproof" / "Legacy" 等）
  variants?: number; // 同硬件变体数量（可选）
  bins?: { stable?: string[]; beta?: string[] }; // 远程返回的版本预览（可选）
}

/** 本地占位 —— 启动时由 fw-source.fetchMetaIndex() 填充 */
export let WLED_MODELS: WledModel[] = [];

/** 更新型号列表（供 fw-source 远程加载后调用） */
export function setModels(models: WledModel[]) {
  WLED_MODELS = models;
}

/** 芯片 → 展示名（和固件实际芯片家族一致） */
export const CHIP_LABEL: Record<string, string> = {
  ESP32: "ESP32",
  "ESP32-S3": "ESP32-S3",
  "ESP32-C3": "ESP32-C3",
  ESP8266: "ESP8266",
};
