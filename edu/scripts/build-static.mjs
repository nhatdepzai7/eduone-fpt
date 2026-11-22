/**
 * Chép phần tĩnh của trang vào dist/ để Vercel chỉ phục vụ những file này.
 * server/, functions/, design-system/, .env.example không nằm trong dist/ nên không ai tải được qua URL.
 * Hàm trong api/ vẫn được Vercel đóng gói từ gốc dự án và import ../server/ bình thường.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const PUBLIC = ['index.html', 'app.html', 'robots.txt', 'sitemap.xml', 'admin', 'js', 'public', 'assets'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of PUBLIC) {
    const from = join(root, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(out, name), { recursive: true });
    console.log('copied', name);
}
