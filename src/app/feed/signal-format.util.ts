/**
 * Funções PURAS de parsing/formatação do feed do Discord — portadas do bot antigo
 * (`bot/index.js`). Sem I/O e sem dependência do discord.js → testáveis por caminho
 * relativo. O `DiscordMonitorService` mapeia a mensagem do discord.js para estas
 * formas mínimas e chama estas funções.
 */

export interface EmbedFieldLike {
  name?: string | null;
  value?: string | null;
}

export interface EmbedLike {
  title?: string | null;
  description?: string | null;
  fields?: EmbedFieldLike[] | null;
  footer?: { text?: string | null } | null;
  author?: { name?: string | null } | null;
}

export interface MessageLike {
  content?: string | null;
  embeds?: EmbedLike[] | null;
}

/** Origem da captura (mapeada da mensagem do usuário que disparou o match). */
export interface OriginLike {
  authorTag: string;
  channelId: string;
  channelName: string;
  guildName?: string | null;
}

/** Escapa HTML para o modo `parse_mode: HTML` do Telegram. */
export function escapeHtml(text: unknown): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Junta content + títulos/descrições/fields/footers dos embeds num texto único. */
export function extractAllText(message: MessageLike): string {
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(message.content);

  for (const embed of message.embeds ?? []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields ?? []) {
      const name = field.name ?? '';
      const value = field.value ?? '';
      if (name || value) parts.push(`${name}: ${value}`);
    }
    if (embed.footer?.text) parts.push(embed.footer.text);
    if (embed.author?.name) parts.push(embed.author.name);
  }
  return parts.join('\n');
}

/**
 * Casa `content` com `pattern`. Se o pattern estiver no formato "/corpo/flags",
 * é tratado como REGEX; caso contrário, substring case-insensitive. Regex inválido
 * → não casa (o caller loga).
 */
export function matchPattern(content: string, pattern: string): boolean {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1) || 'i';
    try {
      return new RegExp(body, flags).test(content);
    } catch {
      return false;
    }
  }
  return content.toLowerCase().includes(pattern.toLowerCase());
}

/** Extrai URLs (markdown `[t](url)` e URLs cruas) do texto, sem duplicar. */
export function extractLinks(text: string): string[] {
  const urls = new Set<string>();
  for (const m of text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g))
    urls.add(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s<>()]+/g)) urls.add(m[0]);
  return [...urls];
}

/** True se a authorTag contém algum dos IDs de bot conhecidos (discriminators). */
export function isKnownBot(
  authorTag: string,
  botIds: readonly string[],
): boolean {
  return botIds.some((id) => authorTag.includes(id));
}

/** Formata a captura para o Telegram (HTML) — porta a lógica do bot antigo. */
export function formatForTelegram(
  targetMessage: MessageLike,
  origin: OriginLike,
): string {
  let out = '';

  const userName = escapeHtml(origin.authorTag);
  const channelName = origin.guildName
    ? `${escapeHtml(origin.guildName)} > #${escapeHtml(origin.channelName)}`
    : 'DM/Grupo Privado';

  out += `📍 <b>Origem:</b> ${userName} em <code>${escapeHtml(origin.channelId)}</code>\n`;
  out += `📢 <b>Canal:</b> ${channelName}\n\n`;

  const embed = targetMessage.embeds?.[0];
  if (embed) {
    if (embed.title) out += `<b>${escapeHtml(embed.title)}</b>\n`;

    if (embed.description) {
      const lines = embed.description.split('\n').filter((l) => l.trim());
      for (let line of lines) {
        line = line
          .replace(/\*\*/g, '')
          .replace(/`/g, '')
          .replace(/➡︎/g, '➜')
          .replace(/⋅/g, '•');

        if (line.includes('FDV:')) {
          out += `<b>💎 FDV:</b> <code>${escapeHtml(line.split('FDV:')[1]?.trim())}</code>\n`;
        } else if (line.includes('Liq:')) {
          out += `<b>💧 Liquidez:</b> <code>${escapeHtml(line.split('Liq:')[1]?.trim())}</code>\n`;
        } else if (line.includes('Vol:')) {
          out += `<b>📊 Volume:</b> <code>${escapeHtml(line.split('Vol:')[1]?.trim())}</code>\n`;
        } else if (line.includes('USD:')) {
          out += `<b>💵 Preço:</b> <code>${escapeHtml(line.split('USD:')[1]?.trim())}</code>\n`;
        } else if (line.includes('1H:')) {
          out += `<b>📈 1H:</b> <code>${escapeHtml(line.split('1H:')[1]?.trim())}</code>\n`;
        } else if (line.includes('TH:')) {
          out += `<b>👥 Top Holders:</b> <code>${escapeHtml(line.split('TH:')[1]?.trim())}</code>\n`;
        } else if (line.includes('Total:') && line.includes('avg')) {
          out += `<b>🤝 Holders:</b> <code>${escapeHtml(line.split('Total:')[1]?.trim())}</code>\n`;
        } else if (line.includes('Fresh')) {
          out += `<b>🌱 Fresh:</b> <code>${escapeHtml(line.trim())}</code>\n`;
        } else if (line.includes('Chart:') || line.includes('More:')) {
          const links = line.match(/\[([^\]]+)\]\(([^)]+)\)/g);
          if (links) {
            const label = line.includes('Chart:') ? '📊 Gráficos' : '🔗 Links';
            out += `<b>${label}:</b> `;
            out +=
              links
                .map((m) => {
                  const parsed = m.match(/\[([^\]]+)\]\(([^)]+)\)/);
                  const t = parsed?.[1] ?? '';
                  const u = parsed?.[2] ?? '';
                  return `<a href="${escapeHtml(u)}">${escapeHtml(t)}</a>`;
                })
                .join(' • ') + '\n';
          }
        } else if (
          /^(0x)?[a-fA-F0-9]{40,}$/i.test(line) ||
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(line)
        ) {
          out += `\n<b>📝 Contract:</b>\n<code>${escapeHtml(line.trim())}</code>\n`;
        } else if (line.includes('PVP matches')) {
          out += `\n<b>⚔️ ${escapeHtml(line.trim())}</b>\n`;
        } else if (line.trim() && line.length < 150 && !line.includes('http')) {
          out += `${escapeHtml(line.trim())}\n`;
        }
      }
    }

    for (const field of embed.fields ?? []) {
      if (field.name && field.value) {
        out += `\n<b>${escapeHtml(field.name)}:</b> ${escapeHtml(field.value)}`;
      }
    }

    if (embed.footer?.text)
      out += `\n\n<i>👁️ ${escapeHtml(embed.footer.text)}</i>`;
  } else {
    out += `<code>${escapeHtml(targetMessage.content || extractAllText(targetMessage))}</code>`;
  }

  return out;
}
