import { reactive, shallowRef } from "vue";
import type {
  Analysis,
  AuditionState,
  StageDocument,
  TrackState,
} from "../../../shared/types";
import { analyse } from "../lib/analyse";
import { demoBuffer } from "../lib/demo";
import { scheduleFades } from "../lib/fades";
import {
  audioMemoryLimit,
  MemoryBudgetError,
  pcmBytes,
} from "../lib/memory";

interface Track {
  state: TrackState;
  buffer: AudioBuffer;
  trim: GainNode;
  vol: GainNode;
  source: AudioBufferSourceNode | undefined;
}

interface Audition {
  trackId: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  queued: number;
  raf: number;
}

const PREVIEW_TAIL = 0.08;

export function createAudio(doc: StageDocument) {
  const state = reactive({
    playing: false,
    loading: false,
    error: "",
    looping: true,
    position: 0,
    duration: 0,
    loopEnd: 0,
    memoryUsed: 0,
    memoryLimit: audioMemoryLimit(),
    mic: false,
    tracks: [] as TrackState[],
    audition: {
      active: false,
      trackId: "",
      position: 0,
    } as AuditionState,
  });
  const frame = shallowRef<Analysis>({
    bins: Array(128).fill(0),
    wave: Array(256).fill(0),
    rms: 0,
    bass: 0,
    beat: false,
    time: 0,
  });

  let ctx: AudioContext,
    analyser: AnalyserNode,
    mixGain: GainNode,
    masterGain: GainNode,
    recordDest: MediaStreamAudioDestinationNode;
  let micStream: MediaStream | undefined,
    micSource: MediaStreamAudioSourceNode | undefined;
  const tracks: Track[] = [];
  const byId = new Map<string, Track>();
  /** 时间线位置 0 对应的 AudioContext 时间，所有轨道共用这一条传输时钟 */
  let origin = 0;
  let raf = 0;
  let epoch = 0;
  let lastAppliedGain = -1;
  let audition: Audition | undefined;
  let loopTimer = 0;

  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    mixGain = ctx.createGain();
    masterGain = ctx.createGain();
    recordDest = ctx.createMediaStreamDestination();
    // 所有轨道 -> 混音母线 -> 主输出 -> 分析/录制/监听，三者听到的是同一总混音
    mixGain.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(ctx.destination);
    analyser.connect(recordDest);
    masterGain.gain.value = doc.gain;
    lastAppliedGain = doc.gain;
  }

  // ---------- 传输时钟：暂停/跳转/循环都以同一绝对时间锚点重排 ----------

  function clipEnd(t: Track): number {
    return t.state.offset + t.state.duration;
  }

  function recomputeBounds() {
    const end = tracks.reduce((m, t) => Math.max(m, clipEnd(t)), 0);
    state.loopEnd = end;
    state.duration = end;
    state.memoryUsed = tracks.reduce((s, t) => s + t.state.size, 0);
  }

  function effectiveGain(t: Track): number {
    const soloActive = tracks.some((x) => x.state.solo);
    if (soloActive) return t.state.solo ? t.state.volume : 0;
    return t.state.muted ? 0 : t.state.volume;
  }

  function applyLevel(t: Track) {
    if (!ctx) return;
    // setTargetAtTime 平滑切换，静音/独奏/音量变化都不产生爆音
    t.vol.gain.setTargetAtTime(effectiveGain(t), ctx.currentTime, 0.015);
  }

  function applyFades(t: Track) {
    if (!ctx || !t.source || !state.playing) return;
    scheduleFades(t.trim.gain, ctx.currentTime, origin, {
      offset: t.state.offset,
      duration: t.state.duration,
      fadeIn: t.state.fadeIn,
      fadeOut: t.state.fadeOut,
    });
  }

  function stopSource(t: Track) {
    if (t.source) {
      const node = t.source;
      t.source = undefined;
      node.onended = null;
      try {
        node.stop();
      } catch {}
      node.disconnect();
    }
  }

  /**
   * 在启动锚点 when、时间线位置 pos 处启动一条轨道。
   * when/pos 对所有轨道相同，源缓冲偏移由公共 origin 反推，
   * 因此不同采样率/时长的素材始终样本级对齐，不会越播越偏。
   * 即使片段起点在未来也照常启动，淡入前的 trim 增益保持 0 使其静音等待。
   */
  function startSource(t: Track, pos: number, when: number) {
    // 整个片段已在播放位置之前：无需启动（跳转/循环到其末尾之后）
    if (pos >= clipEnd(t)) return;
    // 片段尚未开始：从缓冲头部起播，trim 增益在 offset 之前保持 0
    const rel =
      pos <= t.state.offset ? 0 : Math.min(pos - t.state.offset, t.state.duration);
    const node = ctx.createBufferSource();
    node.buffer = t.buffer;
    node.loop = true;
    node.connect(t.trim);
    scheduleFades(t.trim.gain, when, origin, {
      offset: t.state.offset,
      duration: t.state.duration,
      fadeIn: t.state.fadeIn,
      fadeOut: t.state.fadeOut,
    });
    node.start(when, rel);
    // 到片段结尾后留少量余量再停止，淡出末端由 trim 增益收到 0
    node.stop(when + (t.state.duration - rel) + 0.05);
    node.onended = () => {
      if (t.source === node) t.source = undefined;
    };
    t.source = node;
  }

  /**
   * 以「当前时刻 + delay」为启动锚点，把所有轨道整体重排到时间线位置 pos。
   * origin 始终由 ctx.currentTime 推导，故调用方传入的 when 一律是相对延迟；
   * 循环场景传入精确边界时同样先换算回相对延迟，保证语义统一、不漂移。
   */
  function relaunchAt(pos: number, delay = 0.02) {
    clearTimeout(loopTimer);
    loopTimer = 0;
    const when = ctx.currentTime + delay;
    origin = when - pos;
    for (const t of tracks) {
      stopSource(t);
      startSource(t, pos, when);
    }
  }

  function relaunchAtCurrent() {
    if (!ctx || !state.playing || tracks.length === 0) return;
    relaunchAt(state.position);
  }

  function loopBoundarySoon() {
    if (!state.looping || state.loopEnd <= 0) return;
    const now = ctx.currentTime;
    const pos = now - origin;
    if (pos + 0.25 < state.loopEnd) return;
    const anchor = origin + state.loopEnd;
    if (now < anchor) {
      // 在精确边界时间触发，定时器抖动不影响对齐（使用绝对时间启动）
      clearTimeout(loopTimer);
      const wait = Math.max(0, anchor - now - 0.005) * 1000;
      loopTimer = setTimeout(() => {
        loopTimer = 0;
        if (!state.playing || !state.looping) return;
        if (ctx.currentTime - origin >= state.loopEnd - 0.002)
          // 边界已到/临近：以 0 延迟立即在边界重排
          relaunchAt(0, 0);
      }, wait);
    } else {
      relaunchAt(0, 0);
    }
  }

  function pump() {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (state.playing) {
      const pos = now - origin;
      if (state.looping && state.loopEnd > 0 && pos >= state.loopEnd) {
        // 越过边界：把启动锚点精确对齐到边界时间，循环往返不累积偏差
        const delay = origin + state.loopEnd - now;
        relaunchAt(0, delay);
        state.position = Math.max(0, now - origin);
      } else if (!state.looping && state.loopEnd > 0 && pos >= state.loopEnd) {
        // 不循环：播到时间线末尾自动停止并归零
        clearTimeout(loopTimer);
        loopTimer = 0;
        for (const t of tracks) stopSource(t);
        state.playing = false;
        state.position = state.loopEnd;
      } else {
        state.position = Math.max(0, pos);
      }
      loopBoundarySoon();
    }
    if (Math.abs(lastAppliedGain - doc.gain) > 0.0001) {
      masterGain.gain.setTargetAtTime(doc.gain, now, 0.03);
      lastAppliedGain = doc.gain;
    }
    const f = new Uint8Array(analyser.frequencyBinCount),
      w = new Uint8Array(analyser.fftSize);
    analyser.smoothingTimeConstant = doc.smoothing;
    analyser.getByteFrequencyData(f);
    analyser.getByteTimeDomainData(w);
    frame.value = analyse(
      f,
      w,
      state.position,
      doc.sensitivity,
      frame.value.bass,
    );
    raf = requestAnimationFrame(pump);
  }

  function ensurePump() {
    if (!raf) raf = requestAnimationFrame(pump);
  }

  // ---------- 传输控制 ----------

  async function play() {
    init();
    await ctx.resume();
    if (state.playing) return;
    if (
      tracks.length > 0 &&
      state.loopEnd > 0 &&
      state.position >= state.loopEnd
    ) {
      state.position = 0; // 已播到末尾，再次播放从头开始
    }
    state.playing = true;
    if (tracks.length > 0) {
      const when = ctx.currentTime + 0.02;
      origin = when - state.position;
      for (const t of tracks) startSource(t, state.position, when);
    }
    ensurePump();
  }

  function pause() {
    if (!state.playing) return;
    clearTimeout(loopTimer);
    loopTimer = 0;
    state.position = ctx.currentTime - origin;
    for (const t of tracks) stopSource(t);
    state.playing = false;
  }

  function seek(pos: number) {
    const target = Math.max(0, Math.min(pos, Math.max(0, state.loopEnd)));
    if (state.playing) {
      relaunchAt(target);
      state.position = target;
    } else {
      state.position = target;
    }
  }

  function toggleLoop() {
    state.looping = !state.looping;
    if (!state.looping) {
      clearTimeout(loopTimer);
      loopTimer = 0;
    }
  }

  // ---------- 轨道管理 ----------

  function mountTrack(name: string, buffer: AudioBuffer): Track {
    init();
    const ts = reactive<TrackState>({
      id: crypto.randomUUID(),
      name,
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      size: pcmBytes(buffer),
      volume: 1,
      muted: false,
      solo: false,
      offset: 0,
      fadeIn: 0,
      fadeOut: 0,
    });
    const trim = ctx.createGain();
    const vol = ctx.createGain();
    trim.gain.value = 1;
    vol.gain.value = 1;
    trim.connect(vol);
    vol.connect(mixGain);
    const t: Track = {
      state: ts,
      buffer,
      trim,
      vol,
      source: undefined,
    };
    tracks.push(t);
    byId.set(ts.id, t);
    state.tracks.push(ts);
    recomputeBounds();
    if (state.playing) startSource(t, state.position, ctx.currentTime + 0.03);
    return t;
  }

  async function addFile(file: File) {
    init();
    const ticket = ++epoch;
    state.loading = true;
    state.error = "";
    try {
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      if (ticket !== epoch) return;
      const need = pcmBytes(decoded);
      // 内存预算：不足时明确拒绝，丢弃新素材，绝不改动在播轨道的音质
      if (state.memoryUsed + need > state.memoryLimit) {
        state.error = new MemoryBudgetError(
          need,
          state.memoryLimit - state.memoryUsed,
        ).message;
        return;
      }
      mountTrack(file.name, decoded);
    } catch {
      if (ticket === epoch)
        state.error = "无法解码此音频，请选择有效的音频文件；当前演出未受影响。";
    } finally {
      if (ticket === epoch) state.loading = false;
    }
  }

  function addDemo() {
    init();
    ++epoch;
    state.error = "";
    mountTrack("Midnight / 120 BPM (演示)", demoBuffer(ctx));
  }

  function removeTrack(id: string) {
    const i = tracks.findIndex((t) => t.state.id === id);
    if (i < 0) return;
    if (audition?.trackId === id) cancelAudition();
    const [t] = tracks.splice(i, 1);
    byId.delete(id);
    stopSource(t);
    t.trim.disconnect();
    t.vol.disconnect();
    state.tracks.splice(
      state.tracks.findIndex((x) => x.id === id),
      1,
    );
    recomputeBounds();
    for (const other of tracks) applyLevel(other);
    if (state.playing) {
      if (state.position >= state.loopEnd && state.loopEnd > 0)
        relaunchAt(0);
    } else if (state.position > state.loopEnd) {
      state.position = state.loopEnd;
    }
  }

  function requireTrack(id: string): Track {
    const t = byId.get(id);
    if (!t) throw Error(`轨道不存在：${id}`);
    return t;
  }

  function setVolume(id: string, v: number) {
    const t = requireTrack(id);
    t.state.volume = Math.max(0, Math.min(1, v));
    applyLevel(t);
  }

  function toggleMute(id: string) {
    const t = requireTrack(id);
    t.state.muted = !t.state.muted; // 独奏解除后恢复此静音状态
    applyLevel(t);
  }

  function toggleSolo(id: string) {
    const t = requireTrack(id);
    t.state.solo = !t.state.solo;
    // 独奏临时覆盖静音；取消独奏后静音选择原样生效
    for (const x of tracks) applyLevel(x);
  }

  function setFade(id: string, kind: "fadeIn" | "fadeOut", seconds: number) {
    const t = requireTrack(id);
    const cap = t.state.duration / 2;
    t.state[kind] = Math.max(0, Math.min(seconds, cap));
    applyFades(t);
  }

  function setOffset(id: string, seconds: number) {
    const t = requireTrack(id);
    t.state.offset = Math.max(0, seconds);
    recomputeBounds();
    if (state.playing) relaunchAtCurrent();
  }

  // ---------- 演出中拖动预听（不触碰录制母线） ----------

  function flushAudition() {
    if (!audition || !ctx || ctx.state === "closed") return;
    const a = audition;
    a.raf = 0;
    if (a.queued < 0) return;
    const t = byId.get(a.trackId);
    const pos = a.queued;
    a.queued = -1;
    if (!t) return;
    try {
      // 旧预览淡出后停止，避免爆音
      a.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.012);
      const old = a.source;
      const oldGain = a.gain;
      const tailEnd = ctx.currentTime + PREVIEW_TAIL;
      try {
        old.stop(tailEnd);
      } catch {}
      old.onended = () => {
        try {
          oldGain.disconnect();
        } catch {}
      };
      const g = ctx.createGain();
      const s = ctx.createBufferSource();
      s.buffer = t.buffer;
      s.loop = true;
      s.connect(g);
      // 预听只进监听（扬声器），不进分析/录制母线：录制继续收旧混音
      g.connect(ctx.destination);
      const clamped = Math.max(0, Math.min(pos, t.state.duration));
      s.start(0, clamped);
      g.gain.value = 0;
      g.gain.setTargetAtTime(effectiveGain(t), ctx.currentTime, 0.012);
      a.source = s;
      a.gain = g;
      state.audition.position = clamped;
    } catch {
      /* 上下文关闭等竞态：忽略本次预听刷新 */
    }
  }

  function preview(id: string, clipPosition: number) {
    init();
    void ctx.resume();
    const t = requireTrack(id);
    if (!audition || audition.trackId !== id) {
      cancelAudition();
      const g = ctx.createGain();
      const s = ctx.createBufferSource();
      s.buffer = t.buffer;
      s.loop = true;
      s.connect(g);
      g.connect(ctx.destination);
      const clamped = Math.max(0, Math.min(clipPosition, t.state.duration));
      s.start(0, clamped);
      g.gain.value = 0;
      // 预听同样遵循静音/独奏规则，且永远不进入录制/分析母线
      g.gain.setTargetAtTime(effectiveGain(t), ctx.currentTime, 0.012);
      audition = {
        trackId: id,
        source: s,
        gain: g,
        queued: -1,
        raf: 0,
      };
      state.audition = { active: true, trackId: id, position: clamped };
    } else {
      audition.queued = clipPosition;
      // rAF 合帧，拖动事件再密集也不会反复创建节点
      if (!audition.raf)
        audition.raf = requestAnimationFrame(() => flushAudition());
    }
  }

  function stopAuditionNode(a: Audition) {
    if (!ctx) return;
    cancelAnimationFrame(a.raf);
    a.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.012);
    try {
      const end = ctx.currentTime + PREVIEW_TAIL;
      a.source.stop(end);
      a.source.onended = () => {
        try {
          a.gain.disconnect();
        } catch {}
      };
    } catch {}
  }

  function cancelAudition() {
    if (!audition) return;
    stopAuditionNode(audition);
    audition = undefined;
    state.audition = { active: false, trackId: "", position: 0 };
  }

  /** 确认拖动：提交新偏移（正在播放则整体无缝重排），并结束预听 */
  function commitMove(id: string, timelineOffset: number) {
    cancelAudition();
    setOffset(id, timelineOffset);
  }

  // ---------- 麦克风（不监听，仅进分析/录制母线，保持原有行为） ----------

  async function microphone() {
    init();
    const ticket = ++epoch;
    state.error = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ticket !== epoch) {
        stream.getTracks().forEach((x) => x.stop());
        return;
      }
      stopMicrophone();
      micStream = stream;
      micSource = ctx.createMediaStreamSource(stream);
      micSource.connect(analyser);
      state.mic = true;
      await ctx.resume();
      ensurePump();
    } catch {
      state.error = "麦克风不可用或未获授权，原有音源已保留。";
    }
  }

  function stopMicrophone() {
    micSource?.disconnect();
    micSource = undefined;
    micStream?.getTracks().forEach((x) => x.stop());
    micStream = undefined;
    state.mic = false;
  }

  function dispose() {
    ++epoch;
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(loopTimer);
    loopTimer = 0;
    cancelAudition();
    for (const t of tracks) stopSource(t);
    stopMicrophone();
    void ctx?.close();
  }

  return {
    state,
    frame,
    play,
    pause,
    seek,
    toggleLoop,
    addFile,
    addDemo,
    removeTrack,
    setVolume,
    toggleMute,
    toggleSolo,
    setFade,
    setOffset,
    preview,
    cancelAudition,
    commitMove,
    microphone,
    stopMicrophone,
    dispose,
    stream: () => {
      init();
      return recordDest.stream;
    },
  };
}

export type AudioEngine = ReturnType<typeof createAudio>;
