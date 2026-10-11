'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, mfaCodeSchema } from '@medigest/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ClinzoraLogo } from '@/components/clinzora-logo';
import { PasskeyLoginButton } from '@/components/passkeys';
import { InstallAppButton } from '@/components/pwa';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Notice } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') && params.get('next')!.startsWith('/') ? params.get('next')! : '/';
  const [step, setStep] = useState<'login' | 'mfa'>(params.get('mfa') ? 'mfa' : 'login');
  const [error, setError] = useState<string | null>(null);

  const login = useForm<{ email: string; password: string }>({ resolver: zodResolver(loginSchema) });
  const mfa = useForm<{ code: string }>({ resolver: zodResolver(mfaCodeSchema) });

  const submitLogin = login.handleSubmit(async (values) => {
    setError(null);
    try {
      const r = await api.post<{ mfaRequired: boolean }>('/auth/login', values);
      if (r.mfaRequired) setStep('mfa');
      else router.replace(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  const submitMfa = mfa.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/mfa/verify', values);
      router.replace(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex justify-center lg:hidden">
        <ClinzoraLogo variant="vertical" height={140} priority />
      </div>
      <h2 className="text-2xl font-semibold text-navy-900">{step === 'login' ? 'Iniciar sesión' : 'Verificación en dos pasos'}</h2>
      <p className="mt-1 text-sm text-muted">{step === 'login' ? 'Ingrese con su cuenta institucional.' : 'Escriba el código de 6 dígitos de su aplicación autenticadora.'}</p>

      {params.get('expirada') && step === 'login' && <Notice tone="sky" className="mt-5">Su sesión expiró. Inicie sesión nuevamente.</Notice>}
      {error && <Notice tone="red" className="mt-5">{error}</Notice>}

      {step === 'login' ? (
        <form onSubmit={submitLogin} className="mt-6 space-y-4" noValidate>
          <Field label="Correo electrónico" error={login.formState.errors.email?.message} htmlFor="email">
            <Input id="email" type="email" autoComplete="username" autoFocus {...login.register('email')} aria-invalid={!!login.formState.errors.email} />
          </Field>
          <Field label="Contraseña" error={login.formState.errors.password?.message} htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" {...login.register('password')} aria-invalid={!!login.formState.errors.password} />
          </Field>
          <Button type="submit" className="w-full" loading={login.formState.isSubmitting}>Entrar</Button>
          <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-border" />o<span className="h-px flex-1 bg-border" /></div>
          <PasskeyLoginButton onSuccess={() => router.replace(next)} onError={setError} />
          <p className="text-center text-sm">
            <Link href="/recuperar" className="text-navy-600 hover:underline">¿Olvidó su contraseña?</Link>
          </p>
          <div className="flex justify-center pt-2"><InstallAppButton /></div>
        </form>
      ) : (
        <form onSubmit={submitMfa} className="mt-6 space-y-4" noValidate>
          <Field label="Código" error={mfa.formState.errors.code?.message} htmlFor="code">
            <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus className="text-center text-lg tracking-[0.4em]" {...mfa.register('code')} />
          </Field>
          <Button type="submit" className="w-full" loading={mfa.formState.isSubmitting}>Verificar</Button>
          <button type="button" className="w-full text-sm text-muted hover:text-navy-700" onClick={async () => { await api.post('/auth/logout').catch(() => undefined); setStep('login'); }}>
            Usar otra cuenta
          </button>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
