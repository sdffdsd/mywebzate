// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // 站点正式域名（影响 canonical / og:url / sitemap，换域名时记得同步改这里）
  site: 'https://za4ever.com',

  // 纯静态输出：国内 CDN / 境外 CDN / 任意 Nginx 都能直接托管
  output: 'static',

  build: {
    // 小体积 CSS 直接内联，减少首屏请求数（弱网关键优化）
    inlineStylesheets: 'auto',
  },

  // 视口内链接预取，站内跳转接近瞬时
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },

  compressHTML: true,

  vite: {
    build: {
      // 按页面拆分 CSS（默认行为）。
      //
      // 曾经设成 false，实测后果是：Vite 把所有 CSS 合并成唯一一份 style.css，
      // Astro 会把这份文件注入「每一个页面」——包括一个样式都不 import 的 /wired/。
      // 而它的 <link> 位置在各页 <style> 之后，于是主站的 body/配色/字体
      // 会反过来覆盖分站自己写的样式（同级选择器后者胜）。
      //
      // 拆开之后：主站各页只加载自己用到的 CSS，/wired/ 完全不加载主站样式。
      // 资源仍然落在 /_astro/* 下（带 hash），public/_headers 的 immutable 规则照常生效。
      cssCodeSplit: true,
    },
  },
});
