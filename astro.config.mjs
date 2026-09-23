// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // 上线前改成你自己的域名（Cloudflare Pages 自定义域名 / 香港服务器域名）
  site: 'https://example.com',

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
      // 动效库（three / gsap）都是动态 import，这里避免被合并进首屏包
      cssCodeSplit: false,
    },
  },
});
