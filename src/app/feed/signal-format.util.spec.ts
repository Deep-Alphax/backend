import {
  escapeHtml,
  extractAllText,
  extractLinks,
  formatForTelegram,
  isKnownBot,
  matchPattern,
  type MessageLike,
  type OriginLike,
} from './signal-format.util';

describe('signal-format.util', () => {
  describe('matchPattern', () => {
    it('regex "/corpo/flags" casa CA Ethereum', () => {
      const ca = '0xAbC0000000000000000000000000000000000123';
      expect(matchPattern(`compra ${ca}`, '/0x[a-fA-F0-9]{40}/i')).toBe(true);
    });

    it('regex não casa quando não há padrão', () => {
      expect(matchPattern('mensagem qualquer', '/0x[a-fA-F0-9]{40}/i')).toBe(
        false,
      );
    });

    it('substring é case-insensitive', () => {
      expect(matchPattern('tem PVP Matches aqui', 'PVP matches')).toBe(true);
      expect(matchPattern('sem nada', 'PVP matches')).toBe(false);
    });

    it('regex inválido não quebra (retorna false)', () => {
      expect(matchPattern('abc', '/[/')).toBe(false);
    });

    it('CA Solana (base58) casa a regex correspondente', () => {
      const sol = '4y96HLdkСcccccccccccccccccccccccc'.replace(
        /[^1-9A-HJ-NP-Za-km-z]/g,
        'A',
      );
      expect(matchPattern(sol, '/[1-9A-HJ-NP-Za-km-z]{32,44}/')).toBe(true);
    });
  });

  describe('extractAllText', () => {
    it('junta content + título/descrição/fields/footer dos embeds', () => {
      const msg: MessageLike = {
        content: 'olha isso',
        embeds: [
          {
            title: 'TOKEN',
            description: 'FDV: 120K',
            fields: [{ name: 'Liq', value: '5K' }],
            footer: { text: 'via bot' },
          },
        ],
      };
      const text = extractAllText(msg);
      expect(text).toContain('olha isso');
      expect(text).toContain('TOKEN');
      expect(text).toContain('FDV: 120K');
      expect(text).toContain('Liq: 5K');
      expect(text).toContain('via bot');
    });

    it('mensagem vazia → string vazia', () => {
      expect(extractAllText({})).toBe('');
    });
  });

  describe('extractLinks', () => {
    it('extrai URLs cruas e de markdown, sem duplicar', () => {
      const text =
        'veja [Chart](https://dexscreener.com/x) e https://t.me/y e https://dexscreener.com/x';
      const links = extractLinks(text);
      expect(links).toContain('https://dexscreener.com/x');
      expect(links).toContain('https://t.me/y');
      expect(
        links.filter((l) => l === 'https://dexscreener.com/x'),
      ).toHaveLength(1);
    });
  });

  describe('escapeHtml', () => {
    it('escapa caracteres perigosos', () => {
      expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#039;');
    });
    it('null/undefined → vazio', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });

  describe('isKnownBot', () => {
    it('detecta pelo discriminator na tag', () => {
      expect(isKnownBot('Rick#9725', ['9725', '8106'])).toBe(true);
      expect(isKnownBot('User#1234', ['9725'])).toBe(false);
    });
  });

  describe('formatForTelegram', () => {
    const origin: OriginLike = {
      authorTag: 'user#0001',
      channelId: '123',
      channelName: 'alpha',
      guildName: 'MeuServer',
    };

    it('inclui origem e formata FDV/contract com HTML seguro', () => {
      const target: MessageLike = {
        embeds: [
          {
            title: 'PEPE',
            description:
              'FDV: 120K\n0xabc0000000000000000000000000000000000123',
          },
        ],
      };
      const html = formatForTelegram(target, origin);
      expect(html).toContain('📍 <b>Origem:</b>');
      expect(html).toContain('MeuServer > #alpha');
      expect(html).toContain('<b>💎 FDV:</b>');
      expect(html).toContain('<b>📝 Contract:</b>');
    });

    it('sem embed → usa o content cru escapado', () => {
      const html = formatForTelegram({ content: '<script>' }, origin);
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
