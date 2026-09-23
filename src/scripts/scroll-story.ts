/**
 * 横向长卷动效（GSAP + ScrollTrigger）
 *
 * 设计要点：
 * - 这个模块是动态 import 进来的，只有用户没开 prefers-reduced-motion 才会被下载；
 * - invalidateOnRefresh + 函数式数值：窗口尺寸变化后重新计算轨道宽度；
 * - 结束后恢复成普通布局（ScrollTrigger 自己会清理 pin）。
 */

export async function initScrollStory(section: HTMLElement): Promise<void> {
  const track = section.querySelector<HTMLElement>('[data-story-track]');
  if (!track) return;

  const [{ gsap }, { ScrollTrigger }] = await Promise.all([
    import('gsap'),
    import('gsap/ScrollTrigger'),
  ]);

  gsap.registerPlugin(ScrollTrigger);

  section.dataset.motion = 'on';

  const distance = () =>
    Math.max(0, track.scrollWidth - document.documentElement.clientWidth);

  const tween = gsap.to(track, {
    x: () => -distance(),
    ease: 'none',
    scrollTrigger: {
      trigger: section,
      start: 'top top',
      end: () => `+=${distance() + window.innerHeight * 0.6}`,
      scrub: 0.8,
      pin: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
    },
  });

  // 面板逐个淡入，跟着 scrub 进度走
  const panels = gsap.utils.toArray<HTMLElement>('[data-story-panel]', section);
  panels.forEach((panel) => {
    gsap.fromTo(
      panel,
      { opacity: 0.25, y: 40 },
      {
        opacity: 1,
        y: 0,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: panel,
          containerAnimation: tween,
          start: 'left 88%',
          end: 'left 45%',
          scrub: true,
        },
      },
    );
  });

  // 图片懒加载完成后再刷新一次尺寸，避免轨道宽度算小
  addEventListener(
    'load',
    () => ScrollTrigger.refresh(),
    { once: true },
  );
}
