import { protocol, session } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const APP_SCHEME = 'branchroom';
const APP_ORIGIN = `${APP_SCHEME}://app/`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

export function registerBranchroomScheme(): void {
  // 必须在 app ready 之前调用
  protocol.registerSchemesAsPrivileged([
    {scheme: APP_SCHEME, privileges: {standard: true, secure: true, supportFetchAPI: true}}
  ]);
}

/** 打包后用本地自定义协议提供 renderer 文件；开发模式走 vite dev server，不经过这里。 */
export function registerBranchroomProtocol(rendererRoot: string): void {
  const root = resolve(rendererRoot);
  const notFound = (): Response => new Response(null, {status: 404});

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return notFound();
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const target = resolve(root, relative);
      // 路径穿越防护：解析后的目标必须仍在 renderer 根内
      if (target !== root && !target.startsWith(root + sep)) return notFound();

      let filePath = target;
      let hit = true;
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        hit = false;
      }
      // 单页应用路由回退 index.html；带扩展名的静态资源请求不回退
      if (!hit) {
        if (/\.[a-z0-9]+$/i.test(relative)) return notFound();
        filePath = join(root, 'index.html');
      }

      const body = await readFile(filePath);
      const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(body), {headers: {'content-type': contentType}});
    } catch {
      return notFound();
    }
  });
}

/** 打包环境使用严格 CSP；开发模式需要允许 vite/react-refresh 的内联脚本与 HMR websocket。 */
export function applyContentSecurityPolicy(isDev: boolean): void {
  const policy = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws:"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {...details.responseHeaders, 'Content-Security-Policy': [policy]}
    });
  });
}

export const appOrigin = APP_ORIGIN;
