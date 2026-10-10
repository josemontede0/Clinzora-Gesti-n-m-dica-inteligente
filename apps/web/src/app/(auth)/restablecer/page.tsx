'use client';

import { passwordPolicy } from '@medigest/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Notice } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const policy = passwordPolicy.safeParse(pwd);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!policy.success) return setError(policy.error.issues[0].message);
    if (pwd !== confirm) return setError('Las contraseñas no coinciden');
    setBusy(true);
    try {
      await api.post('/auth/password/reset', { token, newPassword: pwd });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <Notice tone="red">Enlace incompleto. Solicite uno nuevo desde “Recuperar contraseña”.</Notice>;
  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-semibold text-navy-900">Nueva contraseña</h2>
      {done ? (
        <>
          <Notice tone="teal" className="mt-6">Contraseña actualizada. Por seguridad se cerraron todas sus sesiones.</Notice>
          <Button asChild className="mt-4 w-full"><Link href="/login">Iniciar sesión</Link></Button>
        </>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {error && <Notice tone="red">{error}</Notice>}
          <Field label="Nueva contraseña" hint="Mínimo 10 caracteres con mayúscula, minúscula, número y símbolo.">
            <Input type="password" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          </Field>
          <Field label="Confirmar contraseña">
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>Guardar</Button>
        </form>
      )}
    </div>
  );
}

export default function ResetPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
