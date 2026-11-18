<script setup lang="ts">
import { computed } from "vue";
import { Headphones, MoveHorizontal, X } from "lucide-vue-next";
import type { AudioEngine } from "../model/engine";
import type { StageDocument } from "../../../shared/types";
import { clock } from "../../../shared/math";
import { formatMB } from "../index";

const props = defineProps<{ engine: AudioEngine; doc: StageDocument }>();

const FADE_MAX = 8;

const stripSpan = computed(() =>
  Math.max(props.engine.state.loopEnd, 1),
);
const auditionTrack = computed(() =>
  props.engine.state.tracks.find(
    (t) => t.id === props.engine.state.audition.trackId,
  ),
);
const soloActive = computed(() =>
  props.engine.state.tracks.some((t) => t.solo),
);

async function load(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  const wasEmpty = props.engine.state.tracks.length === 0;
  for (const f of files) await props.engine.addFile(f);
  input.value = "";
  if (wasEmpty && props.engine.state.tracks.length > 0)
    void props.engine.play();
}

function pct(seconds: number): number {
  return Math.min(100, (seconds / stripSpan.value) * 100);
}

function stripPosition(e: PointerEvent, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return ratio * stripSpan.value;
}

interface Drag {
  id: string;
  grab: number;
}
let drag: Drag | undefined;

function onClipDown(e: PointerEvent, id: string, offset: number, el: HTMLElement) {
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  const timeline = stripPosition(e, el.parentElement as HTMLElement);
  drag = { id, grab: timeline - offset };
  previewAt(e, id, el);
}

function previewAt(e: PointerEvent, id: string, el: HTMLElement) {
  const t = props.engine.state.tracks.find((x) => x.id === id);
  if (!t) return;
  const timeline = stripPosition(e, el.parentElement as HTMLElement);
  const offset = Math.max(0, timeline - (drag?.grab ?? 0));
  // 预听位置 = 指针落在片段内的相对位置
  const clipPos = Math.max(0, Math.min(timeline - offset, t.duration));
  props.engine.preview(id, clipPos);
}

function onClipMove(e: PointerEvent, id: string, el: HTMLElement) {
  if (!drag || drag.id !== id) return;
  previewAt(e, id, el);
}

function onClipUp(e: PointerEvent, id: string, el: HTMLElement) {
  if (!drag || drag.id !== id) return;
  const timeline = stripPosition(e, el.parentElement as HTMLElement);
  const offset = Math.max(0, timeline - drag.grab);
  // 确认：提交新偏移（播放中则无缝整体重排），录制母线从未被预听触碰
  props.engine.commitMove(id, offset);
  drag = undefined;
}

function onClipCancel() {
  // 取消：丢弃待提交偏移，预听淡出，不留爆音
  props.engine.cancelAudition();
  drag = undefined;
}

function onStripSeek(e: PointerEvent, el: HTMLElement) {
  if (drag) return;
  props.engine.seek(stripPosition(e, el));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.engine.state.audition.active) {
    props.engine.cancelAudition();
    drag = undefined;
  }
}
</script>

<template>
  <section class="panel audio-panel" @keydown="onKeydown">
    <div class="panel-heading">
      <span>01 / MULTITRACK MIXER</span
      ><span class="dot" :class="{ on: engine.state.playing }"></span>
    </div>
    <h3>多轨伴奏，同一条时间线</h3>

    <div class="source-tabs">
      <label class="file-button"
        >导入音频<input
          type="file"
          accept="audio/*"
          multiple
          @change="load" /></label
      ><button @click="engine.addDemo()">演示音轨</button
      ><button
        :class="{ selected: engine.state.mic }"
        @click="engine.state.mic ? engine.stopMicrophone() : engine.microphone()"
      >
        麦克风
      </button>
    </div>

    <div class="transport">
      <button
        class="play"
        @click="engine.state.playing ? engine.pause() : engine.play()"
      >
        {{ engine.state.playing ? "Ⅱ" : "▶" }}
      </button>
      <span
        >{{ clock(engine.state.position) }}
        <i>/ {{ clock(engine.state.duration) }}</i></span
      >
      <button
        class="loop-btn"
        :class="{ selected: engine.state.looping }"
        @click="engine.toggleLoop()"
        title="循环播放"
      >
        ↻ 循环
      </button>
      <span class="tag">{{ engine.state.loading ? "解码中" : "SYNC" }}</span>
    </div>

    <div
      class="timeline-ruler"
      title="点击移动播放位置（所有轨道整体对齐）"
      @pointerdown="onStripSeek($event, $event.currentTarget as HTMLElement)"
    >
      <i
        class="playhead"
        :style="{ left: `${pct(engine.state.position)}%` }"
      ></i>
    </div>

    <div v-if="engine.state.audition.active" class="audition-banner">
      <Headphones :size="14" />
      <div>
        <strong>正在预听：{{ auditionTrack?.name }}</strong>
        <small
          >监听预听位置 {{ clock(engine.state.audition.position) }}
          · 录制仍在收旧混音，松开确认 / Esc 取消</small
        >
      </div>
      <button
        class="mini"
        aria-label="取消预听"
        @click="engine.cancelAudition()"
      >
        <X :size="13" />
      </button>
    </div>

    <p v-if="!engine.state.tracks.length" class="muted empty-hint">
      还没有轨道。导入多段音频后，它们会按各自偏移在同一条时间线上同时播放，
      暂停、跳转与循环都不会让轨道互相错位。
    </p>

    <div
      v-for="t in engine.state.tracks"
      :key="t.id"
      class="track-card"
      :class="{
        soloed: t.solo,
        dimmed: soloActive && !t.solo,
        auditioning: engine.state.audition.trackId === t.id,
      }"
    >
      <div class="track-head">
        <div class="album">♫</div>
        <div class="track-meta">
          <strong :title="t.name">{{ t.name }}</strong>
          <small
            >{{ t.sampleRate / 1000 }}kHz · {{ t.channels }}ch ·
            {{ t.duration.toFixed(1) }}s · {{ formatMB(t.size) }}</small
          >
        </div>
        <div class="ms-buttons">
          <button
            class="mini"
            :class="{ selected: t.muted }"
            title="静音（独奏时临时覆盖）"
            @click="engine.toggleMute(t.id)"
          >
            M
          </button>
          <button
            class="mini"
            :class="{ selected: t.solo }"
            title="独奏：临时覆盖静音，取消后恢复原静音状态"
            @click="engine.toggleSolo(t.id)"
          >
            S
          </button>
          <button
            class="mini danger-btn"
            aria-label="移除轨道"
            @click="engine.removeTrack(t.id)"
          >
            ×
          </button>
        </div>
      </div>

      <label class="control"
        >轨道音量 <b>{{ Math.round(t.volume * 100) }}%</b
        ><input
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="t.volume"
          @input="engine.setVolume(t.id, ($event.target as HTMLInputElement).valueAsNumber)"
      /></label>

      <div class="fade-row">
        <label class="control"
          >淡入 <b>{{ t.fadeIn.toFixed(2) }}s</b
          ><input
            type="range"
            min="0"
            :max="FADE_MAX"
            step="0.05"
            :value="t.fadeIn"
            @input="
              engine.setFade(
                t.id,
                'fadeIn',
                ($event.target as HTMLInputElement).valueAsNumber,
              )
            "
        /></label>
        <label class="control"
          >淡出 <b>{{ t.fadeOut.toFixed(2) }}s</b
          ><input
            type="range"
            min="0"
            :max="FADE_MAX"
            step="0.05"
            :value="t.fadeOut"
            @input="
              engine.setFade(
                t.id,
                'fadeOut',
                ($event.target as HTMLInputElement).valueAsNumber,
              )
            "
        /></label>
      </div>

      <div class="clip-row">
        <MoveHorizontal :size="12" class="drag-grip" />
        <div class="clip-strip">
          <div
            class="clip"
            :style="{
              left: `${pct(t.offset)}%`,
              width: `${pct(t.duration)}%`,
            }"
            @pointerdown="onClipDown($event, t.id, t.offset, $event.currentTarget as HTMLElement)"
            @pointermove="onClipMove($event, t.id, $event.currentTarget as HTMLElement)"
            @pointerup="onClipUp($event, t.id, $event.currentTarget as HTMLElement)"
            @pointercancel="onClipCancel()"
          >
            <i
              v-if="t.fadeIn > 0"
              class="fade-zone in"
              :style="{ width: `${Math.min(100, (t.fadeIn / t.duration) * 100)}%` }"
            ></i>
            <i
              v-if="t.fadeOut > 0"
              class="fade-zone out"
              :style="{ width: `${Math.min(100, (t.fadeOut / t.duration) * 100)}%` }"
            ></i>
          </div>
        </div>
      </div>
      <small class="muted offset-label"
        >拖动片段预听新位置 · 起点偏移 {{ t.offset.toFixed(2) }}s</small
      >
    </div>

    <label class="control"
      >监听总音量 <b>{{ Math.round(doc.gain * 100) }}%</b
      ><input
        type="range"
        min="0"
        max="1"
        step="0.01"
        v-model.number="doc.gain" /></label
    ><label class="control"
      >响应灵敏度 <b>{{ doc.sensitivity.toFixed(1) }}×</b
      ><input
        type="range"
        min="0.3"
        max="3"
        step="0.1"
        v-model.number="doc.sensitivity"
    /></label>

    <div class="memory-line muted">
      解码内存预算
      <b
        >{{ formatMB(engine.state.memoryUsed) }} /
        {{ formatMB(engine.state.memoryLimit) }}</b
      >
    </div>
    <p v-if="engine.state.error" role="alert">{{ engine.state.error }}</p>

    <div class="input-level">
      <span
        v-for="i in 28"
        :key="i"
        :class="{ lit: engine.frame.value.rms * 100 > i }"
      ></span>
    </div>
    <small class="muted"
      >MIX BUS LEVEL
      <em>{{ (engine.frame.value.rms * 100).toFixed(1) }} dBFS ref</em></small
    >
  </section>
</template>
