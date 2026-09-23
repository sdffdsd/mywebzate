/**
 * 音频播放器 + 实时频谱（Web Audio API）
 *
 * 关键取舍：
 * - <audio preload="none"> + 静态文件天然支持 Range 206，播到哪下到哪，
 *   不会为了 1 分钟的声音先拉 10MB；
 * - AudioContext 必须在用户手势里创建（自动播放策略），所以第一次点击才初始化；
 * - 频谱只是"增强"，拿不到 AnalyserNode 时播放器仍然可用。
 */

export interface PlayerElements {
  audio: HTMLAudioElement;
  canvas: HTMLCanvasElement;
  toggle: HTMLButtonElement;
  bar: HTMLElement;
  fill: HTMLElement;
  time: HTMLElement;
}

const fmt = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function initAudioPlayer(els: PlayerElements): void {
  const { audio, canvas, toggle, bar, fill, time } = els;
  const ctx = canvas.getContext('2d');

  let analyser: AnalyserNode | null = null;
  let freq: Uint8Array<ArrayBuffer> | null = null;
  let audioCtx: AudioContext | null = null;
  let raf = 0;
  let smoothed: number[] = [];

  const ensureGraph = () => {
    if (audioCtx) return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      audioCtx = new Ctor();
      const source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.82;
      freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch {
      // 某些浏览器/隐私模式下会抛错：放弃频谱，只保留播放
      analyser = null;
      audioCtx = null;
    }
  };

  /* ---------------------------- 频谱绘制 ---------------------------- */

  const resizeCanvas = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 140;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
  };

  const drawIdle = () => {
    if (!ctx) return;
    resizeCanvas();
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);

    const bars = 64;
    const gap = 3;
    const bw = (w - gap * (bars - 1)) / bars;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < bars; i++) {
      const bh = h * (0.06 + 0.03 * Math.sin(i * 0.6));
      ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
    }
  };

  const drawLive = () => {
    raf = requestAnimationFrame(drawLive);
    if (!ctx || !analyser || !freq) return;

    resizeCanvas();
    const { width: w, height: h } = canvas;
    analyser.getByteFrequencyData(freq);

    const bars = 56;
    const gap = 3;
    const bw = (w - gap * (bars - 1)) / bars;

    if (smoothed.length !== bars) smoothed = new Array(bars).fill(0);

    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(110,231,255,0.95)');
    grad.addColorStop(0.6, 'rgba(167,139,250,0.9)');
    grad.addColorStop(1, 'rgba(240,171,252,0.95)');
    ctx.fillStyle = grad;

    // 只取低频段（人声/氛围音的能量集中区），按对数近似切分
    const usable = Math.floor(freq.length * 0.62);
    for (let i = 0; i < bars; i++) {
      const t0 = Math.floor((i / bars) ** 1.7 * usable);
      const t1 = Math.max(t0 + 1, Math.floor(((i + 1) / bars) ** 1.7 * usable));
      let sum = 0;
      for (let k = t0; k < t1; k++) sum += freq[k] ?? 0;
      const v = sum / (t1 - t0) / 255;
      smoothed[i] = Math.max(v, (smoothed[i] ?? 0) * 0.86);
      const bh = Math.max(3, smoothed[i] * h * 0.96);
      const x = i * (bw + gap);
      ctx.beginPath();
      ctx.roundRect(x, h - bh, bw, bh, 3);
      ctx.fill();
    }
  };

  /* ---------------------------- 交互绑定 ---------------------------- */

  const setToggle = (playing: boolean) => {
    toggle.dataset.playing = playing ? 'true' : 'false';
    toggle.setAttribute('aria-label', playing ? '暂停' : '播放');
    toggle.textContent = playing ? '❚❚' : '▶';
  };

  const syncProgress = () => {
    const d = audio.duration;
    const pct = Number.isFinite(d) && d > 0 ? (audio.currentTime / d) * 100 : 0;
    fill.style.width = `${pct.toFixed(2)}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    time.textContent = `${fmt(audio.currentTime)} / ${fmt(Number.isFinite(d) ? d : 0)}`;
  };

  toggle.addEventListener('click', () => {
    ensureGraph();
    void audioCtx?.resume();

    if (audio.paused) {
      audio
        .play()
        .then(() => {
          if (analyser) {
            cancelAnimationFrame(raf);
            drawLive();
          }
        })
        .catch(() => {
          // 解码失败 / 文件缺失：给出可见反馈
          time.textContent = '音频不可用';
        });
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => setToggle(true));
  audio.addEventListener('pause', () => {
    setToggle(false);
    cancelAnimationFrame(raf);
    drawIdle();
  });
  audio.addEventListener('ended', () => {
    setToggle(false);
    cancelAnimationFrame(raf);
    drawIdle();
    syncProgress();
  });
  audio.addEventListener('timeupdate', syncProgress);
  audio.addEventListener('loadedmetadata', syncProgress);

  const seekFromEvent = (clientX: number) => {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
    syncProgress();
  };

  let dragging = false;

  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  });

  bar.addEventListener('pointermove', (e) => {
    if (dragging) seekFromEvent(e.clientX);
  });

  bar.addEventListener('pointerup', (e) => {
    dragging = false;
    bar.releasePointerCapture(e.pointerId);
  });

  bar.addEventListener('keydown', (e) => {
    const step = 5;
    if (e.key === 'ArrowRight') {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + step);
      syncProgress();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      audio.currentTime = Math.max(0, audio.currentTime - step);
      syncProgress();
      e.preventDefault();
    } else if (e.key === ' ' || e.key === 'Enter') {
      toggle.click();
      e.preventDefault();
    }
  });

  addEventListener('resize', () => {
    if (audio.paused) drawIdle();
  });

  drawIdle();
  syncProgress();
}
