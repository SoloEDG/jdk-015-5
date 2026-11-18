export type SceneKind = "orbit" | "spectrum" | "wave" | "tunnel";
export interface Scene {
  id: string;
  name: string;
  kind: SceneKind;
  theme: string;
  intensity: number;
  speed: number;
}
export interface Analysis {
  bins: number[];
  wave: number[];
  rms: number;
  bass: number;
  beat: boolean;
  time: number;
}
export interface TrackState {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  /** 解码后 PCM 占用字节数，用于内存预算 */
  size: number;
  volume: number;
  muted: boolean;
  solo: boolean;
  /** 轨道在时间线上的起点（秒） */
  offset: number;
  fadeIn: number;
  fadeOut: number;
}
export interface AuditionState {
  active: boolean;
  trackId: string;
  position: number;
}
export interface StageDocument {
  scenes: Scene[];
  activeId: string;
  gain: number;
  sensitivity: number;
  smoothing: number;
  transition: number;
  blackout: boolean;
  frozen: boolean;
  strobe: boolean;
  master: number;
}
export interface Take {
  id: string;
  url: string;
  size: number;
  duration: number;
  name: string;
  mime: string;
}
export interface Theme {
  id: string;
  name: string;
  colors: [string, string, string];
  background: string;
}
