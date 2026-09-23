import * as THREE from 'three';

/**
 * 首屏 WebGL 背景：一片全屏着色器平面（极光 / 流场），不加载任何贴图与模型。
 *
 * 体积与性能策略：
 * - three 由调用方动态 import()，首屏关键路径不含它；
 * - DPR 上限 1.5，标签页隐藏 / 离开视口时停帧；
 * - 不支持 WebGL 或用户偏好降低动效时，直接跳过，保留 CSS 渐变兜底。
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform vec2  uMouse;
  uniform vec2  uRes;
  uniform float uIntensity;

  // --- 值噪声 + fbm ---
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = rot * p * 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 p = (uv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);

    // 鼠标轻微视差
    p += (uMouse - 0.5) * 0.18;

    float t = uTime * 0.06;
    float flow = fbm(p * 1.6 + vec2(t, -t * 0.7));
    float detail = fbm(p * 4.2 - vec2(t * 1.4, t * 0.9));

    // 极光带：把噪声压成一条斜向光带
    float band = smoothstep(0.25, 0.95, flow * 0.75 + detail * 0.45);
    float glow = pow(band, 1.6);

    vec3 cyan = vec3(0.43, 0.91, 1.0);
    vec3 violet = vec3(0.65, 0.55, 0.98);
    vec3 pink = vec3(0.94, 0.67, 0.99);

    vec3 col = mix(violet, cyan, clamp(flow * 1.2, 0.0, 1.0));
    col = mix(col, pink, clamp(detail * 0.65, 0.0, 1.0));

    // 暗角，保证前景文字可读
    float vignette = smoothstep(1.15, 0.25, length(uv - 0.5) * 1.7);

    gl_FragColor = vec4(col * glow * uIntensity * vignette, 1.0);
  }
`;

export interface HeroHandle {
  stop: () => void;
}

export function startHero(canvas: HTMLCanvasElement): HeroHandle | null {
  let renderer: THREE.WebGLRenderer;

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
    });
  } catch {
    return null;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();

  const uniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uIntensity: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  const dpr = () => Math.min(window.devicePixelRatio || 1, 1.5);

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(dpr());
    renderer.setSize(w, h, false);
    uniforms.uRes.value.set(w, h);
  };

  resize();
  addEventListener('resize', resize, { passive: true });

  // 鼠标 / 触摸视差
  const onPointer = (x: number, y: number) => {
    uniforms.uMouse.value.set(x / window.innerWidth, 1 - y / window.innerHeight);
  };
  const onMouseMove = (e: MouseEvent) => onPointer(e.clientX, e.clientY);
  addEventListener('mousemove', onMouseMove, { passive: true });

  let visible = true;
  let running = true;

  const onVisibility = () => {
    visible = !document.hidden;
  };
  document.addEventListener('visibilitychange', onVisibility);

  const io = new IntersectionObserver(
    ([entry]) => {
      running = entry?.isIntersecting ?? true;
    },
    { threshold: 0 },
  );
  io.observe(canvas);

  const clock = new THREE.Clock();
  let raf = 0;

  const dispose = () => {
    cancelAnimationFrame(raf);
    removeEventListener('resize', resize);
    removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('visibilitychange', onVisibility);
    io.disconnect();
    quad.geometry.dispose();
    material.dispose();
    renderer.dispose();
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (!visible || !running) return;

    const t = clock.getElapsedTime();
    uniforms.uTime.value = t;

    // 入场淡入（约 1.2s）
    uniforms.uIntensity.value = Math.min(1, uniforms.uIntensity.value + 0.012);

    renderer.render(scene, camera);
  };

  loop();

  return { stop: dispose };
}
