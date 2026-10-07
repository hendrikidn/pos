import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly name: string;
  send(m: MailMessage): Promise<void>;
}

export const MAILER = 'MAILER';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true untuk port 465 (TLS langsung); false untuk 587 (STARTTLS). */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Hanya untuk uji dengan server SMTP tiruan lokal. */
  allowPlain?: boolean;
}

/** Pengiriman lewat SMTP biasa: cocok dengan penyedia email transaksional apa pun (Brevo, Resend, SES, Mailgun, Zoho, dan sejenisnya). */
export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  private readonly transport;

  constructor(private readonly cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      ...(cfg.allowPlain ? { ignoreTLS: true } : { requireTLS: !cfg.secure }),
    });
  }

  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.cfg.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  }
}

/** SMTP belum dikonfigurasi: email tidak terkirim, dan isinya (termasuk kode) TIDAK dicetak ke log. */
export class UnconfiguredMailer implements Mailer {
  readonly name = 'unconfigured';
  async send(m: MailMessage): Promise<void> {
    console.warn(`[mail] SMTP belum dikonfigurasi; email "${m.subject}" ke ${m.to} tidak terkirim. Isi SMTP_HOST, MAIL_FROM, dan seterusnya.`);
  }
}

/** Untuk demo lokal: mencetak seluruh isi email, termasuk kode masuk, ke konsol. Jangan dipakai di produksi. */
export class ConsoleMailer implements Mailer {
  readonly name = 'console';
  async send(m: MailMessage): Promise<void> {
    console.log(`\n[mail → ${m.to}] ${m.subject}\n${m.text}\n`);
  }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const host = env['SMTP_HOST'];
  if (!host) return new UnconfiguredMailer();
  const from = env['MAIL_FROM'];
  if (!from) throw new Error('MAIL_FROM wajib diisi bila SMTP_HOST diisi (mis. "Anatta POS <no-reply@dolanyu.com>")');
  const port = Number(env['SMTP_PORT'] ?? 587);
  // Hanya untuk menguji dengan server SMTP lokal tanpa TLS. Jangan diaktifkan di produksi: email dan sandi SMTP terkirim tanpa enkripsi.
  const allowPlain = env['SMTP_ALLOW_PLAIN'] === 'true';
  if (allowPlain) console.warn('PERINGATAN: SMTP_ALLOW_PLAIN aktif; koneksi SMTP tanpa TLS. Hanya untuk uji lokal.');
  return new SmtpMailer({
    host, port, from,
    secure: env['SMTP_SECURE'] ? env['SMTP_SECURE'] === 'true' : port === 465,
    user: env['SMTP_USER'] || undefined,
    pass: env['SMTP_PASS'] || undefined,
    allowPlain,
  });
}
