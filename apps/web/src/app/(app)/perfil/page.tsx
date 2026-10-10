'use client';

import { passwordPolicy } from '@medigest/shared';
import { QRCodeSVG } from 'qrcode.react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Badge, Card, CardBody, CardHeader, DefinitionList, Notice, PageHeader } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

function Profile() {
  const { me, refresh } = useSession();
  const forced = useSearchParams().get('obligatorio');
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');

  const changePassword = async () => {
    const policy = passwordPolicy.safeParse(pwd.newPassword);
    if (!policy.success) return toast.error(policy.error.issues[0].message);
    if (pwd.newPassword !== pwd.confirm) return toast.error('Las contraseñas no coinciden');
    setBusy(true);
    try {
      await api.post('/auth/password/change', { currentPassword: pwd.currentPassword, newPassword: pwd.newPassword });
      toast.success('Contraseña actualizada. Se cerraron sus otras sesiones.');
      setPwd({ currentPassword: '', newPassword: '', confirm: '' });
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const enableMfa = async () => {
    try {
      await api.post('/auth/mfa/enable', { code });
      toast.success('Verificación en dos pasos activada');
      setSetup(null);
      setCode('');
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!me) return null;
  return (
    <>
      <PageHeader title="Mi perfil" />
      {forced && (me.mustChangePassword || me.mfaSetupRequired) && (
        <Notice tone="amber" className="mb-6">
          {me.mustChangePassword ? 'Debe cambiar su contraseña temporal antes de continuar. ' : ''}
          {me.mfaSetupRequired ? 'Su rol exige activar la verificación en dos pasos.' : ''}
        </Notice>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Cuenta" />
          <CardBody>
            <DefinitionList items={[
              { label: 'Nombre', value: me.fullName },
              { label: 'Correo', value: me.email },
              { label: 'Organización', value: me.organization.name },
              { label: 'Roles', value: me.roles.join(', ') },
              { label: 'Sucursales', value: me.branches.map((b) => b.name).join(', ') },
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Cambiar contraseña" description="Mínimo 10 caracteres con mayúscula, minúscula, número y símbolo. No puede repetir las últimas 5." />
          <CardBody className="space-y-4">
            <Field label="Contraseña actual"><Input type="password" autoComplete="current-password" value={pwd.currentPassword} onChange={(e) => setPwd({ ...pwd, currentPassword: e.target.value })} /></Field>
            <Field label="Nueva contraseña"><Input type="password" autoComplete="new-password" value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })} /></Field>
            <Field label="Confirmar"><Input type="password" autoComplete="new-password" value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} /></Field>
            <Button loading={busy} disabled={!pwd.currentPassword || !pwd.newPassword} onClick={changePassword}>Actualizar contraseña</Button>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={<span className="flex items-center gap-2">Verificación en dos pasos {me.mfaEnabled ? <Badge tone="teal">Activa</Badge> : <Badge tone="amber">Inactiva</Badge>}</span>} description="Use una aplicación autenticadora (Google Authenticator, Microsoft Authenticator, etc.)." />
          <CardBody>
            {me.mfaEnabled ? <p className="text-sm text-muted">Al iniciar sesión se le pedirá el código de 6 dígitos. Si pierde el dispositivo, solicite a un administrador que restablezca su MFA.</p> : setup ? (
              <div className="flex flex-col gap-6 sm:flex-row">
                <div className="rounded-xl border border-border bg-white p-3"><QRCodeSVG value={setup.otpauthUrl} size={180} /></div>
                <div className="flex-1 space-y-4">
                  <p className="text-sm">Escanee el código con su aplicación o ingrese esta clave manualmente:</p>
                  <p className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm">{setup.secret}</p>
                  <Field label="Código de 6 dígitos"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="max-w-[180px] text-center tracking-[0.3em]" /></Field>
                  <Button variant="success" disabled={code.length !== 6} onClick={enableMfa}>Activar</Button>
                </div>
              </div>
            ) : <Button variant="outline" onClick={async () => { try { setSetup(await api.post('/auth/mfa/setup')); } catch (e) { toast.error(errorMessage(e)); } }}>Configurar verificación en dos pasos</Button>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export default function ProfilePage() {
  return (
    <Suspense>
      <Profile />
    </Suspense>
  );
}
