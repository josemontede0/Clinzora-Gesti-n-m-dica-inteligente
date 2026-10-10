'use client';

import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PatientForm, type PatientFormValues } from '@/components/patients/patient-form';
import { ErrorState, LoadingBlock, PageHeader } from '@/components/ui/layout';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

interface Detail extends PatientFormValues {
  recordNumber: string;
  contacts: { kind: string; name: string; relationship: string | null; phone: string | null; documentNumber: string | null }[];
}

export default function EditPatientPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, loading, error, reload } = useApi<Detail>(`/patients/${id}`);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <LoadingBlock rows={8} />;
  const emergency = data.contacts.find((c) => c.kind === 'EMERGENCY');
  const guardian = data.contacts.find((c) => c.kind === 'GUARDIAN');
  return (
    <>
      <PageHeader title="Editar paciente" breadcrumbs={[{ label: 'Pacientes', href: '/pacientes' }, { label: data.recordNumber, href: `/pacientes/${id}` }, { label: 'Editar' }]} />
      <PatientForm
        initial={{
          firstName: data.firstName, lastName: data.lastName, documentType: data.documentType, documentNumber: data.documentNumber, sex: data.sex,
          birthDate: data.birthDate ? String(data.birthDate).slice(0, 10) : null, phone: data.phone, email: data.email, address: data.address, city: data.city,
          province: data.province, adminNotes: data.adminNotes,
          emergencyContact: emergency ? { name: emergency.name, relationship: emergency.relationship, phone: emergency.phone } : null,
          guardian: guardian ? { name: guardian.name, relationship: guardian.relationship, phone: guardian.phone, documentNumber: guardian.documentNumber } : null,
        }}
        submitLabel="Guardar cambios"
        onCancel={() => router.back()}
        onSubmit={async (values) => {
          const { confirmDuplicate, consents, ...payload } = values;
          void confirmDuplicate;
          void consents;
          await api.put(`/patients/${id}`, payload);
          toast.success('Datos actualizados');
          router.push(`/pacientes/${id}`);
        }}
      />
    </>
  );
}
