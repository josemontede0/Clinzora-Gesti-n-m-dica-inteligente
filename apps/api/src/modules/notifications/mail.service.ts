import { Injectable } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../../config';
import { logger } from '../../common/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Contiene enlaces o datos que no deben registrarse en logs. */
  sensitive?: boolean;
}

export interface SendResult {
  provider: string;
  providerMessageId?: string;
  testMode: boolean;
}

/**
 * Envío de correo. En NOTIFICATIONS_MODE=test (o sin SMTP configurado) NO se envía nada a la red:
 * el mensaje se escribe en MAIL_OUTBOX_DIR para inspección local y se marca como modo prueba.
 */
@Injectable()
export class MailService {
  private transporter: Transporter | null = null;

  get live(): boolean {
    return config.NOTIFICATIONS_MODE === 'live' && !!config.SMTP_HOST;
  }

  async send(msg: MailMessage): Promise<SendResult> {
    if (!this.live) {
      mkdirSync(config.mailOutboxDir, { recursive: true });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const file = join(config.mailOutboxDir, `${id}.txt`);
      writeFileSync(file, `MODO PRUEBA — este mensaje NO fue enviado\nPara: ${msg.to}\nAsunto: ${msg.subject}\n\n${msg.text}\n`, 'utf8');
      logger.log(`Correo en modo prueba guardado en la bandeja local (${id})`, 'MailService');
      return { provider: 'test-outbox', providerMessageId: id, testMode: true };
    }
    this.transporter ??= nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT ?? 587,
      secure: (config.SMTP_PORT ?? 587) === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
    const info = await this.transporter.sendMail({ from: config.SMTP_FROM, to: msg.to, subject: msg.subject, text: msg.text });
    // SMTP solo confirma aceptación por el servidor, no la entrega al buzón.
    return { provider: 'smtp', providerMessageId: info.messageId, testMode: false };
  }
}
