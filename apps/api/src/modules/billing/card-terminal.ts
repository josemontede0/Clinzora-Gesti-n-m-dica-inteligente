import { Injectable } from '@nestjs/common';
import { config } from '../../config';

export interface CardChargeRequest {
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  /** Datos ya capturados por el terminal/POS; el sistema nunca recibe PAN ni CVV. */
  cardLast4: string | null;
  cardBrand: string | null;
  reference: string | null;
}

export interface CardChargeResult {
  provider: string;
  testMode: boolean;
  approved: boolean;
  externalId: string | null;
  authCode: string | null;
  responseCode: string;
  responseMessage: string;
}

/**
 * Adaptador del procesador de tarjetas.
 *  - "test": terminal de PRUEBAS. Aprueba salvo que los últimos 4 dígitos sean 0002 (declinada).
 *    Toda transacción queda marcada testMode=true. Prohibido en producción (ver config).
 *  - "none": no hay integración directa. El cobro se hace en un POS externo (CardNet, Azul…) y el cajero
 *    registra el número de aprobación del voucher, que es la confirmación verificable del cobro.
 * Para integrar un procesador real, implemente este contrato con su API y su modo sandbox.
 */
@Injectable()
export class CardTerminal {
  async charge(req: CardChargeRequest): Promise<CardChargeResult> {
    if (config.PAYMENTS_PROVIDER === 'test') {
      const declined = req.cardLast4 === '0002';
      return {
        provider: 'terminal-pruebas',
        testMode: true,
        approved: !declined,
        externalId: `TEST-${req.idempotencyKey}`,
        authCode: declined ? null : `T${String(Math.abs(hash(req.idempotencyKey)) % 1_000_000).padStart(6, '0')}`,
        responseCode: declined ? '05' : '00',
        responseMessage: declined ? 'Declinada (prueba)' : 'Aprobada (prueba)',
      };
    }
    if (!req.reference) {
      return { provider: 'pos-externo', testMode: false, approved: false, externalId: null, authCode: null, responseCode: 'SIN_APROBACION', responseMessage: 'Ingrese el número de aprobación del voucher del POS' };
    }
    return {
      provider: 'pos-externo',
      testMode: false,
      approved: true,
      externalId: req.reference,
      authCode: req.reference,
      responseCode: 'VOUCHER',
      responseMessage: 'Aprobación registrada desde voucher de POS externo',
    };
  }
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
