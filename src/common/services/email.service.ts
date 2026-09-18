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
      'Welcome!',
      `<p>Hi <strong>${this.esc(data.firstName || 'trader')}</strong>,</p>
       <p>Your ${this.esc(this.brand)} account is ready. Connect your wallets (multi-chain)
       and follow your PnL, hold time, fees and performance over time — all in one place.</p>`,
    );
    const text = `Hi ${data.firstName || 'trader'},\n\nYour ${this.brand} account is ready.\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: `Welcome to ${this.brand}`, html, text });
  }

  async sendPasswordResetCode(data: { email: string; firstName: string; code: string }): Promise<void> {
    const html = this.wrap(
      'Reset your password',
      `<p>Hi <strong>${this.esc(data.firstName || 'there')}</strong>,</p>
       <p>Use the code below to reset your password. It expires in 15 minutes.</p>
       ${this.codeCard(data.code)}
       <p style="color:#888;font-size:13px;">If you did not request this, ignore this email.</p>`,
    );
    const text = `Hi ${data.firstName || 'there'},\n\nYour recovery code: ${data.code}\n(Expires in 15 min. If this was not you, ignore it.)\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: 'Reset your password', html, text });
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
      'Confirm your new email',
      `<p>Hi <strong>${this.esc(data.firstName)}</strong>,</p>
       <p>We received a request to change your account email to <strong>${this.esc(data.newEmail)}</strong>.
       Confirm it with the code below (expires in 15 minutes):</p>
       ${this.codeCard(data.code)}
       ${this.infoRows([['Requested at', data.requestDate], ['Location', data.location], ['Device', data.device]])}
       <p style="color:#888;font-size:13px;">If this was not you, change your password right away.</p>`,
    );
    const text = `Hi ${data.firstName},\n\nEmail change code (to ${data.newEmail}): ${data.code}\nRequested at: ${data.requestDate} — ${data.location} — ${data.device}\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: `Confirm your new email — ${this.brand}`, html, text });
  }

  async sendPasswordChangedNotification(data: {
    email: string;
    firstName: string;
    changedAt: string;
    location: string;
    device: string;
  }): Promise<void> {
    const html = this.wrap(
      'Your password was changed',
      `<p>Hi <strong>${this.esc(data.firstName)}</strong>,</p>
       <p>The password for your ${this.esc(this.brand)} account was changed.</p>
       ${this.infoRows([['When', data.changedAt], ['Location', data.location], ['Device', data.device]])}
       <p style="color:#888;font-size:13px;">If this was not you, reset your password and contact support.</p>`,
    );
    const text = `Hi ${data.firstName},\n\nYour password was changed on ${data.changedAt} (${data.location}, ${data.device}).\nIf this was not you, contact support.\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: data.email, subject: `Your password was changed — ${this.brand}`, html, text });
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
      'Your email was changed',
      `<p>Hi <strong>${this.esc(data.firstName)}</strong>,</p>
       <p>Your account email was changed from <strong>${this.esc(data.oldEmail)}</strong> to
       <strong>${this.esc(data.newEmail)}</strong>.</p>
       ${this.infoRows([['When', data.changedAt], ['Location', data.location], ['Device', data.device]])}
       <p style="color:#888;font-size:13px;">If this was not you, contact support immediately.</p>`,
    );
    const text = `Hi ${data.firstName},\n\nYour email was changed from ${data.oldEmail} to ${data.newEmail} on ${data.changedAt}.\n\n${this.brand} — ${this.domain}`;
    // Notifica o e-mail ANTIGO (canal ainda sob controle do titular).
    await this.send({ from: this.from, to: data.oldEmail, subject: `Your email was changed — ${this.brand}`, html, text });
  }

  async send2FACode(
    email: string,
    code: string,
    meta?: { loginDate?: string; loginDevice?: string },
  ): Promise<void> {
    const rows: [string, string][] = [];
    if (meta?.loginDate) rows.push(['When', meta.loginDate]);
    if (meta?.loginDevice) rows.push(['Device', meta.loginDevice]);
    const html = this.wrap(
      'Your sign-in code',
      `<p>Use the code below to finish signing in. It expires in 10 minutes.</p>
       ${this.codeCard(code)}
       ${rows.length ? this.infoRows(rows) : ''}
       <p style="color:#888;font-size:13px;">If this was not you signing in, change your password.</p>`,
    );
    const text = `Your sign-in code: ${code}\n(Expires in 10 min.)\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: email, subject: `${code} is your ${this.brand} code`, html, text });
  }

  async sendAccountDeletionCode(email: string, code: string): Promise<void> {
    const html = this.wrap(
      'Confirm account deletion',
      `<p>You asked to <strong>delete your ${this.esc(this.brand)} account</strong>.
       Use the code below to confirm (expires in 10 minutes):</p>
       ${this.codeCard(code)}
       <p style="color:#b00;font-size:13px;">This cannot be undone. If this was not you, ignore this email and change your password.</p>`,
    );
    const text = `Code to DELETE your account: ${code}\n(Expires in 10 min. This cannot be undone.)\n\n${this.brand} — ${this.domain}`;
    await this.send({ from: this.from, to: email, subject: `Confirm deleting your ${this.brand} account`, html, text });
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
      'Account deleted (LGPD)',
      `<p>A user deleted their own account.</p>
       ${this.infoRows([
         ['ID', a.id],
         ['Name', name],
         ['Email', a.email],
         ['Reason', data.reason],
         ['Created at', iso(a.createdAt)],
         ['Deleted at', iso(a.deletedAt)],
       ])}`,
    );
    const text = `Account deleted (LGPD)\nID: ${a.id}\nName: ${name}\nEmail: ${a.email}\nReason: ${data.reason}\nDeleted at: ${iso(a.deletedAt)}`;
    await this.send({ from: this.from, to: this.privacyEmail, subject: `[LGPD] Account deleted — ${a.id}`, html, text });
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
        <p style="margin:0;color:#6b7280;font-size:12px;">${this.esc(this.brand)} — this is an automated email, please do not reply. ${this.esc(this.domain)}</p>
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
