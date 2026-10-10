import type { INestApplication } from '@nestjs/common';
import { bootApp, Client, key, login } from '../helpers';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Finanzas: facturas, pagos, devoluciones y caja', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let caja: Client, contab: Client;
  const ctx: Record<string, string> = {};

  const newInvoice = async (serviceCode: string, qty = 1) => {
    const service = await prisma.service.findFirstOrThrow({ where: { code: serviceCode } });
    const ch = await caja.post('/charges', { patientId: ctx.patientId, branchId: ctx.branchId, serviceId: service.id, quantity: qty, idempotencyKey: key() });
    expect(ch.status).toBe(201);
    const inv = await caja.post('/invoices', { patientId: ctx.patientId, branchId: ctx.branchId, chargeIds: [ch.body.id] });
    expect(inv.status).toBe(201);
    return inv.body;
  };
  const pay = (amount: string, allocations: { invoiceId: string; amount: string }[], method = ctx.cashId, client = caja) =>
    client.post('/payments', { patientId: ctx.patientId, branchId: ctx.branchId, idempotencyKey: key(), tenders: [{ methodId: method, amount }], allocations });

  beforeAll(async () => {
    ({ app, prisma } = await bootApp());
    caja = await login(app, 'caja@ejemplo.test');
    contab = await login(app, 'contabilidad@ejemplo.test');
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 'CENTRAL' } });
    const patient = await prisma.patient.findFirstOrThrow({ where: { recordNumber: 'EXP-000009' } });
    const cash = await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'EFECTIVO' } });
    const transfer = await prisma.paymentMethod.findFirstOrThrow({ where: { code: 'TRANSF' } });
    Object.assign(ctx, { branchId: branch.id, patientId: patient.id, cashId: cash.id, transferId: transfer.id });
    // Ambos usuarios abren caja (contabilidad en la caja de la sede norte no aplica: usa otra caja de la central).
    const reg = await prisma.cashRegister.findFirstOrThrow({ where: { name: 'Caja 1' } });
    const reg2 = await prisma.cashRegister.create({ data: { organizationId: branch.organizationId, branchId: branch.id, name: 'Caja Supervisión' } });
    const current = await caja.get('/cash/current');
    if (!current.body.session) expect((await caja.post('/cash/sessions', { registerId: reg.id, openingFloat: '1000' })).status).toBe(201);
    expect((await contab.post('/cash/sessions', { registerId: reg2.id, openingFloat: '0' })).status).toBe(403); // contabilidad no opera caja
    ctx.reg2 = reg2.id;
  });

  afterAll(async () => app.close());

  it('un pago puede cubrir varias facturas y lo no aplicado queda como anticipo', async () => {
    const a = await newInvoice('CONS-MG'); // 2,000
    const b = await newInvoice('ECG'); // 1,800
    const res = await pay('5000', [{ invoiceId: a.id, amount: '2000' }, { invoiceId: b.id, amount: '1800' }]);
    expect(res.status).toBe(201);
    expect(res.body.unapplied).toBe('1200.00');
    const credits = await caja.get(`/patients/${ctx.patientId}/account`);
    expect(credits.body.credits.find((c: { id: string }) => c.id === res.body.id).available).toBe('1200.00');

    // Aplicar el anticipo a una nueva factura.
    const c = await newInvoice('CONS-MG');
    const alloc = await caja.post(`/payments/${res.body.id}/allocate`, { invoiceId: c.id, amount: '1200' });
    expect(alloc.status).toBe(200);
    expect(alloc.body.unapplied).toBe('0.00');
    const inv = await caja.get(`/invoices/${c.id}`);
    expect(inv.body.balance).toBe('800');
    // No se puede aplicar dos veces el mismo dinero.
    const twice = await caja.post(`/payments/${res.body.id}/allocate`, { invoiceId: c.id, amount: '100' });
    expect(twice.status).toBe(422);
    ctx.partialInvoice = c.id;
  });

  it('el reverso de un pago restituye el saldo y registra la salida de caja', async () => {
    const inv = await newInvoice('CONS-MG');
    const p = await pay('2000', [{ invoiceId: inv.id, amount: '2000' }]);
    expect((await caja.get(`/invoices/${inv.id}`)).body.status).toBe('PAGADA');
    const denied = await caja.post(`/payments/${p.body.id}/reverse`, { reason: 'Cobro registrado por error' });
    expect(denied.status).toBe(403); // el cajero no tiene payments.refund
    const gerencia = await login(app, 'gerencia@ejemplo.test');
    const noCash = await gerencia.post(`/payments/${p.body.id}/reverse`, { reason: 'Cobro registrado por error' });
    expect(noCash.status).toBe(422); // requiere caja abierta de quien revierte
    // Damos temporalmente al cajero el permiso de reembolso para el escenario.
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'payments.refund' } });
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'CAJA' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    let ok;
    try {
      ok = await caja.post(`/payments/${p.body.id}/reverse`, { reason: 'Cobro registrado por error' });
    } finally {
      await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
    }
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('REVERTIDO');
    const after = await caja.get(`/invoices/${inv.id}`);
    expect(after.body.status).toBe('PENDIENTE');
    expect(after.body.balance).toBe('2000');
    expect(await prisma.payment.count({ where: { id: p.body.id } })).toBe(1); // no se borra
    ctx.reversedInvoice = inv.id;
  });

  it('devolución de un monto cobrado: saldo = facturado − pagado − créditos se mantiene', async () => {
    const inv = await newInvoice('CONS-CAR'); // 3,500
    const p = await pay('3500', [{ invoiceId: inv.id, amount: '3500' }]);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'payments.refund' } });
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'CAJA' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const res = await caja.post(`/invoices/${inv.id}/refund`, { paymentId: p.body.id, amount: '500', methodId: ctx.cashId, reason: 'Servicio cobrado de más', idempotencyKey: key() });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
    expect(res.status).toBe(200);
    const after = await caja.get(`/invoices/${inv.id}`);
    expect(after.body.paidAmount).toBe('3000');
    expect(after.body.creditedAmount).toBe('500');
    expect(after.body.balance).toBe('0');
    expect(Number(after.body.patientAmount) - Number(after.body.paidAmount) - Number(after.body.creditedAmount)).toBe(Number(after.body.balance));
    expect(after.body.creditNotes).toHaveLength(1);
  });

  it('nota de crédito sobre saldo pendiente y anulación con reglas', async () => {
    const nc = await contab.post(`/invoices/${ctx.partialInvoice}/credit-notes`, { amount: '300', reason: 'Descuento autorizado por gerencia' });
    expect(nc.status).toBe(201);
    expect(nc.body.balance).toBe('500');
    const excess = await contab.post(`/invoices/${ctx.partialInvoice}/credit-notes`, { amount: '900', reason: 'Excede el saldo' });
    expect(excess.status).toBe(422);

    const withPayments = await contab.post(`/invoices/${ctx.partialInvoice}/void`, { reason: 'Intento de anular con pagos' });
    expect(withPayments.status).toBe(422);
    expect(withPayments.body.code).toBe('TIENE_PAGOS');
    const voidOk = await contab.post(`/invoices/${ctx.reversedInvoice}/void`, { reason: 'Servicio no realizado' });
    expect(voidOk.status).toBe(200);
    expect(voidOk.body.status).toBe('ANULADA');
    expect(await prisma.invoice.count({ where: { id: ctx.reversedInvoice } })).toBe(1);
  });

  it('comprobante fiscal: solo con rango registrado; una factura con NCF no se anula (requiere nota de crédito)', async () => {
    const inv = await newInvoice('CONS-MG');
    const noRange = await contab.post(`/invoices/${inv.id}/fiscal`, { type: 'B01', buyerRnc: '000000002' });
    expect(noRange.status).toBe(422);
    expect(noRange.body.code).toBe('SIN_RANGO_NCF');
    const ncf = await contab.post(`/invoices/${inv.id}/fiscal`, { type: 'B02' });
    expect(ncf.status).toBe(201);
    expect(ncf.body.ncf).toMatch(/^B02\d{8}$/);
    const voidRes = await contab.post(`/invoices/${inv.id}/void`, { reason: 'Error de facturación' });
    expect(voidRes.status).toBe(422);
    expect(voidRes.body.code).toBe('TIENE_NCF');
  });

  it('cierra la caja con el efectivo esperado correcto', async () => {
    const current = (await caja.get('/cash/current')).body.session;
    const s = current.summary;
    expect(Number(s.expectedCash)).toBe(Number(s.byMethod.EFECTIVO));
    const close = await caja.post(`/cash/sessions/${current.id}/close`, { countedCash: s.expectedCash });
    expect(close.status).toBe(200);
    expect(close.body.difference).toBe('0');
    const paymentAfterClose = await pay('100', []);
    expect(paymentAfterClose.status).toBe(422);
  });
});
