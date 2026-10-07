import { Inject, Injectable, Logger } from '@nestjs/common';
import { ruleLabel, type Incident, type RuleHit } from '@pos/rules';
import { Database } from './db/database';
import type { Notifier } from './pipeline.service';

export interface Message {
  /** Nomor telepon format internasional tanpa tanda plus (mis. 628123456789) */
  to: string;
  text: string;
}

export interface Channel {
  readonly name: string;
  send(message: Message): Promise<void>;
}

export class LogChannel implements Channel {
  readonly name = 'log';
  private readonly log = new Logger('Notification');
  async send(m: Message): Promise<void> {
    this.log.warn(`-> ${m.to}\n${m.text}`);
  }
}

/**
 * WhatsApp Business Cloud API. Pesan dikirim sebagai teks bebas, yang hanya diterima WhatsApp bila penerima
 * sudah berinteraksi dalam 24 jam terakhir. Untuk produksi, pesan awal harus memakai template yang disetujui Meta
 * (lihat `template`), dan itu belum diverifikasi terhadap API sungguhan di sini.
 */
export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';

  constructor(
    private readonly cfg: { token: string; phoneNumberId: string; apiVersion?: string; template?: string; language?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(m: Message): Promise<void> {
    const url = `https://graph.facebook.com/${this.cfg.apiVersion ?? 'v21.0'}/${this.cfg.phoneNumberId}/messages`;
    const body = this.cfg.template
      ? {
          messaging_product: 'whatsapp', to: m.to, type: 'template',
          template: {
            name: this.cfg.template, language: { code: this.cfg.language ?? 'id' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: m.text.replace(/\s*\n\s*/g, ' | ').slice(0, 1024) }] }],
          },
        }
      : { messaging_product: 'whatsapp', to: m.to, type: 'text', text: { body: m.text } };
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

const wib = (ms: number) =>
  new Date(ms + 7 * 3_600_000).toISOString().replace('T', ' ').slice(11, 16);

/** Ringkasan insiden untuk owner. Memuat indikasi, bukan tuduhan: keputusan akhir setelah melihat CCTV. */
export function renderIncidentMessage(incident: Incident, outletName: string, dashboardUrl?: string): string {
  const rules = [...new Map(incident.hits.map((h: RuleHit) => [h.rule, h])).keys()];
  const lines = [
    `[INSIDEN PERLU REVIEW] ${outletName}`,
    `Skor ${incident.score} (${incident.level === 'CRITICAL' ? 'kritis' : incident.level.toLowerCase()})`,
    `Waktu: ${wib(incident.startAt)}–${wib(incident.endAt)} WIB`,
    ...(incident.actorIds.length ? [`Staf terkait: ${incident.actorIds.join(', ')}`] : []),
    `Indikasi: ${rules.map(ruleLabel).join('; ')}`,
    `Cek rekaman CCTV pada jendela waktu di atas sebelum menyimpulkan.`,
    ...(dashboardUrl ? [`${dashboardUrl}/incidents/${encodeURIComponent(incident.id)}`] : []),
  ];
  return lines.join('\n');
}

export interface RecipientInput {
  userId: string;
  role: 'OWNER' | 'OPS';
  phone: string;
  outletId?: string | null;
}

@Injectable()
export class NotificationService implements Notifier {
  private readonly log = new Logger('Notification');

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject('CHANNEL') private readonly channel: Channel,
    @Inject('DASHBOARD_URL') private readonly dashboardUrl: string | undefined,
  ) {}

  async addRecipient(tenantId: string, r: RecipientInput): Promise<void> {
    await this.db.tenantTx(tenantId, (q) =>
      q.query(
        `insert into notification_recipient (tenant_id, outlet_id, user_id, role, phone)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [tenantId, r.outletId ?? null, r.userId, r.role, r.phone],
      ),
    );
  }

  async listRecipients(tenantId: string): Promise<{ id: number; user_id: string; role: string; outlet_id: string | null; phone: string; active: boolean }[]> {
    return this.db.tenantTx(tenantId, async (q) =>
      (await q.query<{ id: number; user_id: string; role: string; outlet_id: string | null; phone: string; active: boolean }>(
        'select id, user_id, role, outlet_id, phone, active from notification_recipient order by id',
      )).rows,
    );
  }

  async deactivateRecipient(tenantId: string, id: number): Promise<void> {
    await this.db.tenantTx(tenantId, (q) => q.query('update notification_recipient set active = false where id = $1', [id]));
  }

  /**
   * Mengirim insiden kritis ke owner/ops aktif untuk outlet itu, kecuali orang yang terlibat di insiden.
   * Satu insiden hanya dikirim sekali per penerima. Kegagalan satu penerima tidak menghalangi yang lain.
   */
  async notifyCritical(tenantId: string, incident: Incident): Promise<void> {
    const targets = await this.db.tenantTx(tenantId, async (q) => {
      const outlet = (await q.query<{ name: string }>('select name from outlet where id = $1', [incident.outletId])).rows[0];
      const recipients = (
        await q.query<{ user_id: string; phone: string }>(
          `select user_id, phone from notification_recipient
           where active and (outlet_id is null or outlet_id = $1)`,
          [incident.outletId],
        )
      ).rows;
      const sent = new Set(
        (
          await q.query<{ user_id: string }>(
            "select user_id from notification_log where incident_id = $1 and channel = $2 and status = 'SENT'",
            [incident.id, this.channel.name],
          )
        ).rows.map((r) => r.user_id),
      );
      return {
        outletName: outlet?.name ?? incident.outletId,
        recipients: recipients.filter((r) => !incident.actorIds.includes(r.user_id) && !sent.has(r.user_id)),
      };
    });

    const text = renderIncidentMessage(incident, targets.outletName, this.dashboardUrl);
    const seen = new Set<string>();
    for (const r of targets.recipients) {
      if (seen.has(r.user_id)) continue; // satu orang dengan beberapa nomor: kirim ke yang pertama saja
      seen.add(r.user_id);
      let status: 'SENT' | 'FAILED' = 'SENT';
      let error: string | null = null;
      try {
        await this.channel.send({ to: r.phone, text });
      } catch (e) {
        status = 'FAILED';
        error = e instanceof Error ? e.message : String(e);
        this.log.error(`gagal mengirim ke ${r.user_id}: ${error}`);
      }
      await this.db.tenantTx(tenantId, (q) =>
        q.query(
          `insert into notification_log (tenant_id, incident_id, user_id, channel, status, error)
           values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
          [tenantId, incident.id, r.user_id, this.channel.name, status, error],
        ),
      );
    }
  }
}

/** WhatsApp bila WHATSAPP_TOKEN dan WHATSAPP_PHONE_NUMBER_ID terisi; selain itu hanya log. */
export function channelFromEnv(env: NodeJS.ProcessEnv = process.env): Channel {
  const token = env['WHATSAPP_TOKEN'];
  const phoneNumberId = env['WHATSAPP_PHONE_NUMBER_ID'];
  if (token && phoneNumberId) {
    return new WhatsAppChannel({ token, phoneNumberId, template: env['WHATSAPP_TEMPLATE'], language: env['WHATSAPP_LANGUAGE'] });
  }
  return new LogChannel();
}
