// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://agenttools.example.com', // Task 12 买了域名后替换为真实域名
  integrations: [sitemap()],
});
