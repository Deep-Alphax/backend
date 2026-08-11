import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailDataRequired } from '@sendgrid/mail';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sgMail = require('@sendgrid/mail');

/**
 * Envio de e-mails transacionais de auth (Deep Alpha). Auto-contido: o HTML é gerado
 * inline (sem arquivos de template), então não há dependência de arquivos em disco.
 * Transporte: SendGrid (`SEND_GRID`). Sem a chave, os envios viram no-op logado.
 *
 * Marca/remetente/domínio são configuráveis por env:
 *   - SMTP_FROM     (default "Deep Alpha <no-reply@deepalpha.app>")
 *   - BRAND_NAME    (default "Deep Alpha")
 *   - BRAND_DOMAIN  (default "deepalpha.app")
 *   - PRIVACY_EMAIL (default "privacy@deepalpha.app") — destino do aviso de exclusão (LGPD).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly from: string;
  private readonly enabled: boolean;
  private readonly brand: string;
  private readonly domain: string;
  private readonly privacyEmail: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('SEND_GRID');
    this.brand = this.configService.get<string>('BRAND_NAME', 'Deep Alpha');
    this.domain = this.configService.get<string>('BRAND_DOMAIN', 'deepalpha.app');
    this.privacyEmail = this.configService.get<string>('PRIVACY_EMAIL', `privacy@${this.domain}`);
    this.from = this.configService.get<string>('SMTP_FROM', `${this.brand} <no-reply@${this.domain}>`);

    if (!apiKey) {
      this.logger.warn('SEND_GRID não configurado — envio de e-mails desabilitado (no-op).');
      this.enabled = false;
      return;
    }
    sgMail.setApiKey(apiKey);
    this.enabled = true;
    this.logger.log('SendGrid inicializado');
  }

  private async send(msg: MailDataRequired): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(`Email desabilitado — envio ignorado (to=${String(msg.to)}).`);
      return;
    }
    try {
      const [response] = await sgMail.send({
        ...msg,
        headers: {
          'List-Unsubscribe': `<mailto:contato@${this.domain}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          ...((msg as any).headers ?? {}),
        },
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
          subscriptionTracking: { enable: false },
        },
      });
      this.logger.log(`SendGrid ${response.statusCode} to=${Array.isArray(msg.to) ? msg.to.join(',') : msg.to}`);
    } catch (error: any) {
      const detail = error?.response?.body ?? error?.message ?? error;
      this.logger.error('Falha ao enviar e-mail (SendGrid):', JSON.stringify(detail));
      throw error;
    }
  }

  // ─────────────────────────── e-mails de auth ───────────────────────────

  async sendWelcomeUser(data: { email: string; firstName: string }): Promise<void> {
    const html = this.wrap(
      'Bem-vindo!',
      `<p>Olá <strong>${this.esc(data.firstName || 'trader')}</strong>,</p>
       <p>Sua conta na ${this.esc(this.brand)} está pronta. Conecte suas carteiras (multi-chain)
       e acompanhe seu PnL, tempo de hold, taxas e desempenho por período — tudo num só lugar.</p>`,
    );
    const text = `Olá ${data.firstName || 'trader'},\n\nSua conta na ${this.brand} está pronta.\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: `Bem-vindo à ${this.brand}`, html, text });
  }

  async sendPasswordResetCode(data: { email: string; firstName: string; code: string }): Promise<void> {
    const html = this.wrap(
      'Redefinição de senha',
      `<p>Olá <strong>${this.esc(data.firstName || 'usuário')}</strong>,</p>
       <p>Use o código abaixo para redefinir sua senha. Ele expira em 15 minutos.</p>
       ${this.codeCard(data.code)}
       <p style="color:#888;font-size:13px;">Se você não solicitou, ignore este e-mail.</p>`,
    );
    const text = `Olá ${data.firstName || 'usuário'},\n\nSeu código de recuperação: ${data.code}\n(Expira em 15 min. Se não foi você, ignore.)\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: 'Redefina sua senha', html, text });
  }

  async sendEmailChangeVerification(data: {
    email: string;
    firstName: string;
    newEmail: string;
    code: string;
    requestDate: string;
    location: string;
    device: string;
  }): Promise<void> {
    const html = this.wrap(
      'Confirmação de troca de e-mail',
      `<p>Olá <strong>${this.esc(data.firstName)}</strong>,</p>
       <p>Recebemos um pedido para alterar o e-mail da sua conta para <strong>${this.esc(data.newEmail)}</strong>.
       Confirme com o código abaixo (expira em 15 minutos):</p>
       ${this.codeCard(data.code)}
       ${this.infoRows([['Solicitado em', data.requestDate], ['Local', data.location], ['Dispositivo', data.device]])}
       <p style="color:#888;font-size:13px;">Se não foi você, altere sua senha imediatamente.</p>`,
    );
    const text = `Olá ${data.firstName},\n\nCódigo para troca de e-mail (para ${data.newEmail}): ${data.code}\nSolicitado em: ${data.requestDate} — ${data.location} — ${data.device}\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: `Confirme a troca de e-mail — ${this.brand}`, html, text });
  }

  async sendPasswordChangedNotification(data: {
    email: string;
    firstName: string;
    changedAt: string;
    location: string;
    device: string;
  }): Promise<void> {
    const html = this.wrap(
      'Sua senha foi alterada',
      `<p>Olá <strong>${this.esc(data.firstName)}</strong>,</p>
       <p>A senha da sua conta ${this.esc(this.brand)} foi alterada.</p>
       ${this.infoRows([['Quando', data.changedAt], ['Local', data.location], ['Dispositivo', data.device]])}
       <p style="color:#888;font-size:13px;">Se não foi você, redefina sua senha e contate o suporte.</p>`,
    );
    const text = `Olá ${data.firstName},\n\nSua senha foi alterada em ${data.changedAt} (${data.location}, ${data.device}).\nSe não foi você, contate o suporte.\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: `Sua senha foi alterada — ${this.brand}`, html, text });
  }

  async sendEmailChangedNotification(data: {
    oldEmail: string;
    newEmail: string;
    firstName: string;
    changedAt: string;
    location: string;
    device: string;
  }): Promise<void> {
    const html = this.wrap(
      'Seu e-mail foi alterado',
      `<p>Olá <strong>${this.esc(data.firstName)}</strong>,</p>
       <p>O e-mail da sua conta foi alterado de <strong>${this.esc(data.oldEmail)}</strong> para
       <strong>${this.esc(data.newEmail)}</strong>.</p>
       ${this.infoRows([['Quando', data.changedAt], ['Local', data.location], ['Dispositivo', data.device]])}
       <p style="color:#888;font-size:13px;">Se não foi você, contate o suporte imediatamente.</p>`,
    );
    const text = `Olá ${data.firstName},\n\nSeu e-mail foi alterado de ${data.oldEmail} para ${data.newEmail} em ${data.changedAt}.\n\n${this.brand} — ${this.domain}`;
    // Notifica o e-mail ANTIGO (canal ainda sob controle do titular).
    await this.send({ from: this.from, to: data.oldEmail, subject: `Seu e-mail foi alterado — ${this.brand}`, html, text });
  }

  async send2FACode(
    email: string,
    code: string,
    meta?: { loginDate?: string; loginDevice?: string },
  ): Promise<void> {
    const rows: [string, string][] = [];
    if (meta?.loginDate) rows.push(['Quando', meta.loginDate]);
    if (meta?.loginDevice) rows.push(['Dispositivo', meta.loginDevice]);
    const html = this.wrap(
      'Seu código de acesso',
      `<p>Use o código abaixo para concluir seu login. Ele expira em 10 minutos.</p>
       ${this.codeCard(code)}
       ${rows.length ? this.infoRows(rows) : ''}
       <p style="color:#888;font-size:13px;">Se não foi você tentando entrar, altere sua senha.</p>`,
    );
    const text = `Seu código de acesso: ${code}\n(Expira em 10 min.)\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: email, subject: `${code} é o seu código ${this.brand}`, html, text });
  }

  async sendAccountDeletionCode(email: string, code: string): Promise<void> {
    const html = this.wrap(
      'Confirmação de exclusão de conta',
      `<p>Você solicitou a <strong>exclusão da sua conta</strong> ${this.esc(this.brand)}.
       Use o código abaixo para confirmar (expira em 10 minutos):</p>
       ${this.codeCard(code)}
       <p style="color:#b00;font-size:13px;">Esta ação é irreversível. Se não foi você, ignore este e-mail e altere sua senha.</p>`,
    );
    const text = `Código para EXCLUIR sua conta: ${code}\n(Expira em 10 min. Ação irreversível.)\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: email, subject: `Confirme a exclusão da sua conta ${this.brand}`, html, text });
  }

  /** Aviso interno de exclusão de conta (LGPD) ao e-mail de privacidade. */
  async sendAccountDeletionNotice(data: {
    reason: string;
    account: {
      id: string;
      firstName?: string | null;
      lastName?: string | null;
      email: string;
      createdAt: Date;
      deletedAt: Date;
    };
  }): Promise<void> {
    const a = data.account;
    const iso = (d: Date) => {
      try {
        return d.toISOString();
      } catch {
        return String(d);
      }
    };
    const name = `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || '—';
    const html = this.wrap(
      'Conta excluída (LGPD)',
      `<p>Um usuário excluiu a própria conta.</p>
       ${this.infoRows([
         ['ID', a.id],
         ['Nome', name],
         ['E-mail', a.email],
         ['Motivo', data.reason],
         ['Criada em', iso(a.createdAt)],
         ['Excluída em', iso(a.deletedAt)],
       ])}`,
    );
    const text = `Conta excluída (LGPD)\nID: ${a.id}\nNome: ${name}\nE-mail: ${a.email}\nMotivo: ${data.reason}\nExcluída em: ${iso(a.deletedAt)}`;
    await this.send({ from: this.from, to: this.privacyEmail, subject: `[LGPD] Conta excluída — ${a.id}`, html, text });
  }

  // ─────────────────────────── helpers de HTML ───────────────────────────

  private esc(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );
  }

  /** Envelope HTML branded (cabeçalho + corpo + rodapé). */
  private wrap(title: string, bodyHtml: string): string {
    return `<!doctype html><html><body style="margin:0;background:#0f1115;padding:24px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#1a1d24;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#111318;padding:20px 28px;border-bottom:1px solid #2a2e37;">
        <span style="color:#e8b23a;font-size:20px;font-weight:700;letter-spacing:.5px;">${this.esc(this.brand)}</span>
      </td></tr>
      <tr><td style="padding:28px;color:#d4d7dd;font-size:15px;line-height:1.6;">
        <h1 style="margin:0 0 16px 0;font-size:18px;color:#fff;">${this.esc(title)}</h1>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #2a2e37;">
        <p style="margin:0;color:#6b7280;font-size:12px;">${this.esc(this.brand)} — este é um e-mail automático, não responda. ${this.esc(this.domain)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  }

  /** Card grande com o código OTP. */
  private codeCard(code: string): string {
    return `<div style="margin:20px 0;text-align:center;">
      <div style="display:inline-block;background:#0f1115;border:1px solid #2a2e37;border-radius:10px;padding:16px 28px;">
        <span style="font-size:30px;font-weight:700;letter-spacing:8px;color:#e8b23a;font-family:monospace;">${this.esc(code)}</span>
      </div></div>`;
  }

  /** Tabela de pares chave→valor. */
  private infoRows(rows: [string, string][]): string {
    const trs = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 0;color:#8b909a;font-size:13px;width:120px;">${this.esc(k)}</td>
           <td style="padding:6px 0;color:#d4d7dd;font-size:13px;">${this.esc(v || '—')}</td></tr>`,
      )
      .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0;width:100%;">${trs}</table>`;
  }
}
