import type { Request as ExpressRequest } from 'express';

/**
 * Extrai o IP "real" do cliente de uma request Express. Considera o header
 * `x-forwarded-for` (proxy/load-balancer/CDN à frente do Node) e cai pra
 * `req.ip` (que o próprio Express resolve quando `trust proxy` está
 * configurado).
 *
 * Por que existe esse util:
 *  - Antes desta função, 4 controllers e o `AuthService` tinham cada um
 *    sua própria implementação levemente divergente — refactor pra fonte
 *    única evita drift de regra (o IP é dado de auditoria e segurança,
 *    diferenças sutis viram bug invisível).
 *  - `x-forwarded-for` pode vir como string única, lista CSV ou array de
 *    strings — o Express normaliza inconsistentemente. Esta função
 *    cobre as 3 formas.
 *  - Retorna `''` quando não há IP detectável (e não `undefined` / `null`)
 *    pra simplificar concatenação em logs.
 *
 * IMPORTANTE: o IP retornado é o "primeiro hop" do XFF (mais próximo do
 * cliente). Em ambientes com múltiplos proxies controlados (CDN → LB →
 * Nginx → Node), confirme que cada hop confiável adiciona ao XFF — caso
 * contrário um cliente pode forjar XFF. Hoje o app usa Cloudflare na
 * frente do app server, então o XFF entregue ao Node é confiável.
 */
export function getClientIp(req: ExpressRequest | undefined): string {
  if (!req) return '';

  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).split(',')[0].trim();
  }

  return (req as ExpressRequest & { ip?: string }).ip || '';
}
