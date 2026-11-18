import { clamp } from "../../../shared/math";

export interface ClipFade {
  /** 片段在时间线上的起点（秒） */
  offset: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * 以绝对 AudioContext 时间为锚点，重排某条轨道 trim 增益上的淡入淡出自动化。
 * 所有时间戳都由同一条传输时钟（origin = 时间线 0 对应的 ctxTime）换算，
 * 因此不同采样率/时长的轨道在暂停、跳转、循环后仍保持样本级对齐。
 */
export function scheduleFades(
  param: AudioParam,
  when: number,
  origin: number,
  clip: ClipFade,
): void {
  const start = origin + clip.offset;
  const end = start + clip.duration;
  const fi = Math.min(clip.fadeIn, clip.duration);
  const fo = Math.min(clip.fadeOut, clip.duration);
  const fiEnd = start + fi;
  const foStart = end - fo;

  function gainAt(t: number): number {
    if (t <= start) return 0;
    if (fi > 0 && t < fiEnd) return clamp((t - start) / fi);
    if (fo > 0 && t >= foStart && t < end)
      return clamp(1 - (t - foStart) / fo);
    if (t >= end) return 0;
    return 1;
  }

  param.cancelScheduledValues(when);
  param.setValueAtTime(gainAt(when), when);
  if (fi > 0 && fiEnd > when) param.linearRampToValueAtTime(1, fiEnd);
  if (fo > 0) {
    if (foStart > when) param.setValueAtTime(1, foStart);
    if (end > when) param.linearRampToValueAtTime(0, end);
  } else if (end > when) {
    // 无淡出也要在结尾收到 0，避免硬切爆音；时间已过则不补排事件
    param.setValueAtTime(0, end);
  }
}
