'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { toast } from 'sonner';
import { PatientForm } from '@/components/patients/patient-form';
import { PageHeader } from '@/components/ui/layout';
import { api } from '@/lib/api';

function NewPatient() {
  const router = useRouter();
  const returnTo = useSearchParams().get('volver');
  return (
    <>
      <PageHeader title="Nuevo paciente" breadcrumbs={[{ label: 'Pacientes', href: '/pacientes' }, { label: 'Nuevo' }]} />
      <PatientForm
        withConsents
        submitLabel="Registrar paciente"
        onCancel={() => router.back()}
        onSubmit={async (values) => {
          const p = await api.post<{ id: string; recordNumber: string }>('/patients', values);
          toast.success(`Paciente registrado con expediente ${p.recordNumber}`);
          // Si se llegó desde "Nueva cita", vuelve allí con el paciente seleccionado.
          router.push(returnTo === 'cita' ? `/agenda/nueva?paciente=${p.id}` : `/pacientes/${p.id}`);
        }}
      />
    </>
  );
}

export default function NewPatientPage() {
  return (
    <Suspense>
      <NewPatient />
    </Suspense>
  );
}
