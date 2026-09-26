// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages 预览配置；买域名后：site 换真实域名、删掉 base、内部链接的 BASE_URL 前缀可保留（会变成 '/'）
  site: 'https://dengzhh.github.io',
  base: '/agent-site',
  integrations: [sitemap()],
});
