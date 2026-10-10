import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  allocateSchema, cashCloseSchema, cashMovementSchema, cashOpenSchema, chargeCreateSchema, creditNoteSchema, fiscalIssueSchema, fiscalSequenceSchema,
  invoiceCreateSchema, invoiceVoidSchema, money, paymentCreateSchema, paymentReverseSchema, refundSchema,
} from '@medigest/shared';
import { z } from 'zod/v4';
import { AuthUser } from '../../common/context';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { ApiZBody, listQuery, ZBody, ZQuery } from '../../common/zod.pipe';
import { NotificationsService } from '../notifications/notifications.service';
import { PatientsService } from '../patients/patients.service';
import { CashService } from './cash.service';
import { ChargesService } from './charges.service';
import { FiscalService } from './fiscal.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

const invoiceListQuery = listQuery.extend({
  status: z.string().optional(),
  patientId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  overdue: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const paymentListQuery = listQuery.extend({
  patientId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  cashSessionId: z.uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Indique el motivo').max(300) });
const invoiceRefundSchema = z.object({
  paymentId: z.uuid(),
  amount: money,
  methodId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
  idempotencyKey: z.string().min(8).max(100),
});

@ApiTags('facturación y caja')
@Controller()
export class BillingController {
  constructor(
    private readonly charges: ChargesService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly cash: CashService,
    private readonly fiscal: FiscalService,
    private readonly patients: PatientsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Cargos ──

  @Get('charges')
  @RequirePermissions('billing.read')
  listCharges(@CurrentUser() user: AuthUser, @ZQuery(z.object({ patientId: z.uuid().optional(), status: z.string().optional(), branchId: z.uuid().optional() })) q: { patientId?: string; status?: string; branchId?: string }) {
    return this.charges.list(user, q);
  }

  @Post('charges')
  @RequirePermissions('billing.write')
  @ApiZBody(chargeCreateSchema)
  createCharge(@CurrentUser() user: AuthUser, @ZBody(chargeCreateSchema) body: z.infer<typeof chargeCreateSchema>) {
    return this.charges.create(user, body);
  }

  @Post('charges/:id/void')
  @HttpCode(200)
  @RequirePermissions('billing.write')
  voidCharge(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(reasonSchema) body: z.infer<typeof reasonSchema>) {
    return this.charges.void(user, id, body.reason);
  }

  // ── Facturas ──

  @Get('invoices')
  @RequirePermissions('billing.read')
  listInvoices(@CurrentUser() user: AuthUser, @ZQuery(invoiceListQuery) q: z.infer<typeof invoiceListQuery>) {
    return this.invoices.list(user, q);
  }

  @Get('invoices/:id')
  @RequirePermissions('billing.read')
  getInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(user, id);
  }

  @Post('invoices')
  @RequirePermissions('billing.write')
  @ApiZBody(invoiceCreateSchema)
  createInvoice(@CurrentUser() user: AuthUser, @ZBody(invoiceCreateSchema) body: z.infer<typeof invoiceCreateSchema>) {
    return this.invoices.create(user, body);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequirePermissions('billing.write')
  issueInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.issue(user, id);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @RequirePermissions('billing.void')
  voidInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(invoiceVoidSchema) body: z.infer<typeof invoiceVoidSchema>) {
    return this.invoices.void(user, id, body.reason);
  }

  @Post('invoices/:id/credit-notes')
  @RequirePermissions('billing.void')
  creditNote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(creditNoteSchema) body: z.infer<typeof creditNoteSchema>) {
    return this.invoices.creditNote(user, id, body.amount, body.reason);
  }

  @Post('invoices/:id/refund')
  @HttpCode(200)
  @RequirePermissions('payments.refund')
  refundInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(invoiceRefundSchema) body: z.infer<typeof invoiceRefundSchema>) {
    return this.payments.refundInvoice(user, id, body);
  }

  @Post('invoices/:id/fiscal')
  @RequirePermissions('fiscal.manage')
  issueFiscal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(fiscalIssueSchema) body: z.infer<typeof fiscalIssueSchema>) {
    return this.fiscal.issueForInvoice(user, id, body);
  }

  // ── Pagos ──

  @Get('payments')
  @RequireAnyPermission('billing.read', 'payments.write')
  listPayments(@CurrentUser() user: AuthUser, @ZQuery(paymentListQuery) q: z.infer<typeof paymentListQuery>) {
    return this.payments.list(user, q);
  }

  @Get('payments/:id')
  @RequireAnyPermission('billing.read', 'payments.write')
  getPayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user, id);
  }

  @Post('payments')
  @RequirePermissions('payments.write')
  @ApiZBody(paymentCreateSchema)
  createPayment(@CurrentUser() user: AuthUser, @ZBody(paymentCreateSchema) body: z.infer<typeof paymentCreateSchema>) {
    return this.payments.create(user, body);
  }

  @Post('payments/:id/allocate')
  @HttpCode(200)
  @RequirePermissions('payments.write')
  allocate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(allocateSchema) body: z.infer<typeof allocateSchema>) {
    return this.payments.allocate(user, id, body.invoiceId, body.amount);
  }

  @Post('payments/:id/reverse')
  @HttpCode(200)
  @RequirePermissions('payments.refund')
  reverse(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(paymentReverseSchema) body: z.infer<typeof paymentReverseSchema>) {
    return this.payments.reverse(user, id, body.reason);
  }

  @Post('payments/:id/refunds')
  @RequirePermissions('payments.refund')
  refund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(refundSchema) body: z.infer<typeof refundSchema>) {
    return this.payments.refund(user, id, body);
  }

  @Get('patients/:id/account')
  @RequireAnyPermission('billing.read', 'payments.write')
  async account(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [summary, credits, openInvoices, pendingCharges] = await Promise.all([
      this.patients.balanceSummary(user.organizationId, id),
      this.payments.patientCredits(user, id),
      this.invoices.list(user, { patientId: id, page: 1, pageSize: 100 }).then((r) => r.items.filter((i) => ['PENDIENTE', 'PARCIAL', 'BORRADOR'].includes(i.status))),
      this.charges.list(user, { patientId: id, status: 'PENDIENTE' }),
    ]);
    return { ...summary, credits, openInvoices, pendingCharges };
  }

  @Post('patients/:id/balance-reminder')
  @HttpCode(200)
  @RequirePermissions('billing.read')
  async balanceReminder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const summary = await this.patients.balanceSummary(user.organizationId, id);
    if (Number(summary.balance) <= 0) return { queued: 0, message: 'El paciente no tiene saldo pendiente' };
    return this.notifications.queueBalanceReminder(user.organizationId, id, summary.balance);
  }

  // ── Caja ──

  @Get('cash/current')
  @RequireAnyPermission('cash.operate', 'cash.supervise')
  currentCash(@CurrentUser() user: AuthUser) {
    return this.cash.current(user);
  }

  @Get('cash/sessions')
  @RequireAnyPermission('cash.operate', 'cash.supervise')
  sessions(@CurrentUser() user: AuthUser, @ZQuery(z.object({ branchId: z.uuid().optional(), status: z.string().optional() })) q: { branchId?: string; status?: string }) {
    return this.cash.list(user, q);
  }

  @Get('cash/sessions/:id')
  @RequireAnyPermission('cash.operate', 'cash.supervise')
  session(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.get(user, id);
  }

  @Post('cash/sessions')
  @RequirePermissions('cash.operate')
  open(@CurrentUser() user: AuthUser, @ZBody(cashOpenSchema) body: z.infer<typeof cashOpenSchema>) {
    return this.cash.open(user, body.registerId, body.openingFloat);
  }

  @Post('cash/sessions/:id/close')
  @HttpCode(200)
  @RequireAnyPermission('cash.operate', 'cash.supervise')
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(cashCloseSchema) body: z.infer<typeof cashCloseSchema>) {
    return this.cash.close(user, id, body.countedCash, body.notes);
  }

  @Post('cash/sessions/:id/movements')
  @RequirePermissions('cash.operate')
  movement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(cashMovementSchema) body: z.infer<typeof cashMovementSchema>) {
    return this.cash.movement(user, id, body.type, body.amount, body.description);
  }

  // ── Fiscal ──

  @Get('fiscal/sequences')
  @RequirePermissions('fiscal.manage')
  fiscalSequences(@CurrentUser() user: AuthUser) {
    return this.fiscal.sequences(user);
  }

  @Post('fiscal/sequences')
  @RequirePermissions('fiscal.manage')
  addSequence(@CurrentUser() user: AuthUser, @ZBody(fiscalSequenceSchema) body: z.infer<typeof fiscalSequenceSchema>) {
    return this.fiscal.addSequence(user, body);
  }

  @Post('fiscal/sequences/:id/deactivate')
  @HttpCode(200)
  @RequirePermissions('fiscal.manage')
  deactivateSequence(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.deactivateSequence(user, id);
  }
}
