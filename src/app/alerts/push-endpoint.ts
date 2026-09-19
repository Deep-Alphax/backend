/**
 * Allowlist dos serviços de Web Push dos navegadores.
 *
 * SEGURANÇA (SSRF): o backend faz POST no `endpoint` que o NAVEGADOR informou.
 * Aceitar qualquer URL deixaria um usuário apontar o nosso servidor para a rede
 * interna (metadata da nuvem, Postgres, Redis) e dispará-lo a cada alerta. Só
 * HTTPS, porta padrão e hosts dos provedores conhecidos passam.
 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com', // Chrome, Edge (Chromium), Opera, Brave, Android
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari (macOS/iOS 16.4+)
]);

const SUFFIX_HOSTS = [
  '.notify.windows.com', // Edge legado / WNS
  '.push.apple.com',
];

const MAX_ENDPOINT_LENGTH = 1024;

export function isAllowedPushEndpoint(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || SUFFIX_HOSTS.some((s) => host.endsWith(s));
}
