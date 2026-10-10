'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@medigest/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Notice } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPage() {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<{ email: string }>({ resolver: zodResolver(forgotPasswordSchema) });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/auth/password/forgot', v);
      setDone(r.message);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-semibold text-navy-900">Recuperar contraseña</h2>
      <p className="mt-1 text-sm text-muted">Le enviaremos un enlace válido por 30 minutos.</p>
      {done ? (
        <Notice tone="teal" className="mt-6">{done}</Notice>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          {error && <Notice tone="red">{error}</Notice>}
          <Field label="Correo electrónico" error={form.formState.errors.email?.message}>
            <Input type="email" autoComplete="username" autoFocus {...form.register('email')} />
          </Field>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Enviar enlace</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link href="/login" className="text-navy-600 hover:underline">Volver al inicio de sesión</Link></p>
    </div>
  );
}
