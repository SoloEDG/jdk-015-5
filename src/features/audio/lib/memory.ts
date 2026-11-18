const MB = 1024 * 1024;

/** 解码后 PCM 占用的精确字节数（Float32，每样本每声道 4 字节） */
export function pcmBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

/**
 * 音频解码预算：设备内存的约四分之一、上限 512MB、保底 64MB。
 * 预算只用于决定是否接受新轨道，绝不用于压缩/降级已在播轨道。
 */
export function audioMemoryLimit(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const gb = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 4;
  return Math.max(64 * MB, Math.min(512 * MB, Math.floor((gb * 1024 * MB) / 4)));
}

export function formatMB(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

export class MemoryBudgetError extends Error {
  constructor(
    need: number,
    free: number,
  ) {
    super(
      `内存不足，已拒绝新增轨道：该素材解码需要 ${formatMB(need)}，当前剩余预算 ${formatMB(free)}。当前演出与在播轨道的音质保持不变。`,
    );
    this.name = "MemoryBudgetError";
  }
}
