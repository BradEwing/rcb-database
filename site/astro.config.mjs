// @ts-check
import { defineConfig } from 'astro/config';

// Project Pages site lives at https://bradewing.github.io/rcb-database/, so the
// build base is /rcb-database/. Every asset/data URL must be base-relative
// (use Astro's import.meta.env.BASE_URL) — never root-relative — or it 404s on
// Pages. See docs/design/static-site.md (Constraints).
export default defineConfig({
  site: 'https://bradewing.github.io',
  base: '/rcb-database',
});
