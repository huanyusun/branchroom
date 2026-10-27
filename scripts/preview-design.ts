import { join } from 'node:path';
const root = join(import.meta.dir, '../reference/design');
const routes = new Map([['/', 'index.html'], ['/app.js', 'app.js']]);
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.BRANCHROOM_DESIGN_PORT || 7458),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const file = routes.get(url.pathname);
    if (request.method !== 'GET' || !file) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(join(root, file)));
  },
});
console.log(`Design reference: http://127.0.0.1:${process.env.BRANCHROOM_DESIGN_PORT || 7458}/`);
