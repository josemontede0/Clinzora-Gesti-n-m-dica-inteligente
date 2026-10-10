import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { config } from '../../config';
import { MailService, SendResult } from './mail.service';

export interface OutgoingMessage {
  channel: NotificationChannel;
  recipient: string;
  subject?: string | null;
  body: string;
}

export class ChannelNotConfigured extends Error {}

/**
 * Adaptadores de canal. En modo prueba ningún adaptador hace llamadas de red: el resultado se marca
 * testMode=true y el estado queda en ENVIADO (nunca ENTREGADO, porque no hay confirmación de un proveedor).
 */
@Injectable()
export class ChannelSender {
  constructor(private readonly mail: MailService) {}

  isLive(channel: NotificationChannel): boolean {
    if (config.NOTIFICATIONS_MODE !== 'live') return false;
    if (channel === 'EMAIL') return !!config.SMTP_HOST;
    if (channel === 'WHATSAPP') return !!(config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN);
    return !!(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM);
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    if (msg.channel === 'EMAIL') return this.mail.send({ to: msg.recipient, subject: msg.subject ?? 'Aviso', text: msg.body });
    if (!this.isLive(msg.channel)) {
      if (config.NOTIFICATIONS_MODE === 'live') {
        throw new ChannelNotConfigured(`Canal ${msg.channel} sin credenciales configuradas`);
      }
      return { provider: `test-${msg.channel.toLowerCase()}`, providerMessageId: `test-${Date.now()}`, testMode: true };
    }
    return msg.channel === 'WHATSAPP' ? this.sendWhatsApp(msg) : this.sendSms(msg);
  }

  /**
   * WhatsApp Business Cloud API (Meta). Fuera de la ventana de 24 h, Meta exige plantillas aprobadas:
   * en producción configure las plantillas en Meta Business y ajuste este payload a type "template".
   */
  private async sendWhatsApp(msg: OutgoingMessage): Promise<SendResult> {
    const url = `https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toE164(msg.recipient), type: 'text', text: { body: msg.body } }),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${data.error?.message ?? 'error'}`);
    return { provider: 'whatsapp-cloud', providerMessageId: data.messages?.[0]?.id, testMode: false };
  }

  private async sendSms(msg: OutgoingMessage): Promise<SendResult> {
    const sid = config.TWILIO_ACCOUNT_SID!;
    const body = new URLSearchParams({ To: toE164(msg.recipient), From: config.TWILIO_FROM!, Body: msg.body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(`SMS ${res.status}: ${data.message ?? 'error'}`);
    return { provider: 'twilio', providerMessageId: data.sid, testMode: false };
  }
}

/** Números dominicanos de 10 dígitos → +1XXXXXXXXXX. */
export function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
