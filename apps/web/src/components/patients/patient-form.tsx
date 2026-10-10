'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CONSENT_LABEL, DOCUMENT_TYPES, formatCedula, formatDate, patientBaseSchema, SEXES } from '@medigest/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader, Notice } from '@/components/ui/layout';
import { ApiError, errorMessage } from '@/lib/api';

export type PatientFormValues = {
  firstName: string;
  lastName: string;
  documentType: (typeof DOCUMENT_TYPES)[number];
  documentNumber?: string | null;
  birthDate?: string | null;
  sex: (typeof SEXES)[number];
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  adminNotes?: string | null;
  emergencyContact?: { name: string; relationship?: string | null; phone?: string | null } | null;
  guardian?: { name: string; relationship?: string | null; phone?: string | null; documentNumber?: string | null } | null;
};

interface Candidate { id: string; recordNumber: string; firstName: string; lastName: string; documentNumber: string | null; birthDate: string | null; phone: string | null; reason: string }

const DOC_LABEL: Record<string, string> = { CEDULA: 'Cédula', PASAPORTE: 'Pasaporte', OTRO: 'Otro documento', NINGUNO: 'Sin documento (menor u otro)' };
const SEX_LABEL: Record<string, string> = { FEMENINO: 'Femenino', MASCULINO: 'Masculino', INTERSEXUAL: 'Intersexual', NO_ESPECIFICADO: 'No especificado' };
const COMM_CONSENTS = ['COMUNICACION_WHATSAPP', 'COMUNICACION_SMS', 'COMUNICACION_EMAIL', 'TRATAMIENTO_DATOS'] as const;

/** Formulario de paciente (alta y edición). Valida con el mismo esquema que la API. */
export function PatientForm({ initial, onSubmit, submitLabel, withConsents, onCancel }: {
  initial?: Partial<PatientFormValues>;
  onSubmit: (values: PatientFormValues & { confirmDuplicate?: boolean; consents?: { type: string; granted: boolean }[] }) => Promise<void>;
  submitLabel: string;
  withConsents?: boolean;
  onCancel?: () => void;
}) {
  const form = useForm<PatientFormValues>({
    resolver: zodResolver(patientBaseSchema) as never,
    defaultValues: { documentType: 'CEDULA', sex: 'NO_ESPECIFICADO', ...initial },
  });
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = form;
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [pending, setPending] = useState<PatientFormValues | null>(null);
  const [consents, setConsents] = useState<Record<string, boolean>>({ COMUNICACION_WHATSAPP: true, COMUNICACION_EMAIL: true, COMUNICACION_SMS: false, TRATAMIENTO_DATOS: true });
  const docType = watch('documentType');
  const [showGuardian, setShowGuardian] = useState(!!initial?.guardian);

  const clean = (v: PatientFormValues): PatientFormValues => ({
    ...v,
    emergencyContact: v.emergencyContact?.name ? v.emergencyContact : null,
    guardian: showGuardian && v.guardian?.name ? v.guardian : null,
  });

  const send = async (values: PatientFormValues, confirmDuplicate = false) => {
    setError(null);
    try {
      await onSubmit({
        ...clean(values),
        confirmDuplicate,
        ...(withConsents ? { consents: COMM_CONSENTS.map((type) => ({ type, granted: !!consents[type] })) } : {}),
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSIBLE_DUPLICADO') {
        setCandidates(e.body?.candidates as Candidate[]);
        setPending(values);
      } else if (e instanceof ApiError && e.code === 'DOCUMENTO_DUPLICADO') {
        setCandidates(e.body?.candidates as Candidate[]);
        setPending(null);
      } else setError(errorMessage(e));
    }
  };

  return (
    <form onSubmit={handleSubmit((v) => send(v))} noValidate className="space-y-6">
      {error && <Notice tone="red">{error}</Notice>}
      <Card>
        <CardHeader title="Datos personales" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Nombres" required error={errors.firstName?.message}><Input {...register('firstName')} autoFocus /></Field>
          <Field label="Apellidos" required error={errors.lastName?.message}><Input {...register('lastName')} /></Field>
          <Field label="Sexo (registro clínico)" error={errors.sex?.message}>
            <Select {...register('sex')}>{SEXES.map((s) => <option key={s} value={s}>{SEX_LABEL[s]}</option>)}</Select>
          </Field>
          <Field label="Tipo de documento" error={errors.documentType?.message}>
            <Select {...register('documentType')}>{DOCUMENT_TYPES.map((d) => <option key={d} value={d}>{DOC_LABEL[d]}</option>)}</Select>
          </Field>
          {docType !== 'NINGUNO' && (
            <Field label="Número de documento" required error={errors.documentNumber?.message} hint={docType === 'CEDULA' ? '11 dígitos, con o sin guiones' : undefined}>
              <Input {...register('documentNumber')} inputMode={docType === 'CEDULA' ? 'numeric' : 'text'} />
            </Field>
          )}
          <Field label="Fecha de nacimiento" error={errors.birthDate?.message}><Input type="date" {...register('birthDate')} max={new Date().toISOString().slice(0, 10)} /></Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Contacto" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Teléfono" error={errors.phone?.message}><Input type="tel" {...register('phone')} placeholder="809-555-0000" /></Field>
          <Field label="Correo electrónico" error={errors.email?.message}><Input type="email" {...register('email')} /></Field>
          <Field label="Ciudad"><Input {...register('city')} /></Field>
          <Field label="Dirección" className="sm:col-span-2"><Input {...register('address')} /></Field>
          <Field label="Provincia"><Input {...register('province')} /></Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Contacto de emergencia y responsable" />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Contacto de emergencia" error={errors.emergencyContact?.name?.message}><Input {...register('emergencyContact.name')} placeholder="Nombre completo" /></Field>
            <Field label="Parentesco"><Input {...register('emergencyContact.relationship')} /></Field>
            <Field label="Teléfono"><Input type="tel" {...register('emergencyContact.phone')} /></Field>
          </div>
          <Checkbox label="El paciente tiene un responsable legal o tutor (menor de edad o representado)" checked={showGuardian} onChange={(e) => setShowGuardian(e.target.checked)} />
          {showGuardian && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Field label="Responsable / tutor" required error={errors.guardian?.name?.message}><Input {...register('guardian.name')} /></Field>
              <Field label="Parentesco"><Input {...register('guardian.relationship')} /></Field>
              <Field label="Teléfono"><Input type="tel" {...register('guardian.phone')} /></Field>
              <Field label="Documento"><Input {...register('guardian.documentNumber')} /></Field>
            </div>
          )}
        </CardBody>
      </Card>

      {withConsents && (
        <Card>
          <CardHeader title="Consentimientos y preferencias de comunicación" description="Solo se envían recordatorios por los canales autorizados. Puede cambiarse luego en la ficha." />
          <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {COMM_CONSENTS.map((c) => (
              <Checkbox key={c} label={CONSENT_LABEL[c]} checked={!!consents[c]} onChange={(e) => setConsents((s) => ({ ...s, [c]: e.target.checked }))} />
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Observaciones administrativas" description="No registre aquí información clínica." />
        <CardBody><Textarea {...register('adminNotes')} /></CardBody>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button>}
        <Button type="submit" variant="success" loading={isSubmitting}>{submitLabel}</Button>
      </div>

      <Dialog
        open={!!candidates}
        onOpenChange={(v) => !v && setCandidates(null)}
        title={pending ? 'Posibles pacientes duplicados' : 'Documento ya registrado'}
        description={pending ? 'Hay expedientes con datos similares. Verifique antes de registrar.' : 'Ya existe un paciente con ese documento de identidad en la organización.'}
        footer={
          <>
            <Button variant="outline" onClick={() => setCandidates(null)}>Revisar datos</Button>
            {pending && (
              <Button variant="success" onClick={async () => { const v = pending; setCandidates(null); await send(v, true); }}>
                Es otra persona, registrar
              </Button>
            )}
          </>
        }
      >
        <ul className="divide-y divide-border rounded-lg border border-border">
          {candidates?.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{c.lastName}, {c.firstName}</p>
                <p className="text-xs text-muted">{c.recordNumber} · {formatCedula(c.documentNumber)} · Nac. {formatDate(c.birthDate)} · {c.phone ?? 'sin teléfono'}</p>
                <p className="text-xs text-amber-700">{c.reason}</p>
              </div>
              <a href={`/pacientes/${c.id}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-navy-600 hover:underline">Ver expediente</a>
            </li>
          ))}
        </ul>
      </Dialog>
    </form>
  );
}
