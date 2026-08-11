/**
 * Saneamento de destino de redirecionamento pós-login (OAuth `redirect_to`).
 *
 * SEGURANÇA (open-redirect / phishing): nunca redirecionar para um valor cru vindo do
 * cliente. Só aceitamos um CAMINHO RELATIVO da própria SPA — qualquer coisa que possa
 * apontar para outro host é rejeitada. Regra idêntica à validação do frontend, replicada
 * no backend (defesa em profundidade — o front sanear não basta).
 *
 * Aceita: `/checkout/ingressos?eventId=XYZ`, `/`, `/eventos/abc`.
 * Rejeita: `http(s)://host`, `//host`, `/\host`, `javascript:`, `data:`, `mailto:`,
 *          caminhos com CR/LF (header/redirect injection) e tudo que não comece com `/`.
 *
 * @returns o caminho saneado, ou `null` se inválido (o caller deve cair no destino default).
 */
export function sanitizeRelativePath(p?: string | null): string | null {
  if (!p || typeof p !== 'string') return null;
  // Deve ser caminho absoluto-relativo (começa com uma única `/`).
  if (p[0] !== '/') return null;
  // Bloqueia `//host` e `/\host` (protocol-relative / backslash trick → outro host).
  if (p[1] === '/' || p[1] === '\\') return null;
  // Bloqueia caracteres de controle, incluindo CR/LF (injeção em header/URL de redirect).
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return null;
  }
  return p;
}
