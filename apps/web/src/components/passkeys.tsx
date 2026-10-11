'use client';

import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { formatDateTime } from '@medigest/shared';
import { Fingerprint, ScanFace, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/layout';
import { ApiError, api, errorMessage } from '@/lib/api';

// Llaves de acceso (WebAuthn): Face ID / Touch ID en iPhone, huella o rostro en Android, Windows Hello.

const isApple = () => typeof navigator !== 'undefined' && /iPhone|iPad|Macintosh/.test(navigator.userAgent);
const cancelled = (e: unknown) => ['NotAllowedError', 'AbortError'].includes((e as { name?: string })?.name ?? '');

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Dispositivo';
}

export function BiometricIcon({ className }: { className?: string }) {
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(isApple()), []);
  return apple ? <ScanFace className={className} /> : <Fingerprint className={className} />;
}

/** Botón "Entrar con Face ID / huella" de la pantalla de inicio de sesión. */
export function PasskeyLoginButton({ onSuccess, onError }: { onSuccess: () => void; onError: (msg: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [apple, setApple] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSupported(browserSupportsWebAuthn()); setApple(isApple()); }, []);
  if (!supported) return null;
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { challengeId, options } = await api.post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/auth/passkeys/login/options');
          const response = await startAuthentication({ optionsJSON: options });
          await api.post('/auth/passkeys/login', { challengeId, response });
          onSuccess();
        } catch (e) {
          if (!cancelled(e)) onError(e instanceof ApiError ? errorMessage(e) : 'No se pudo usar la llave de acceso en este dispositivo.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <BiometricIcon /> {apple ? 'Entrar con Face ID' : 'Entrar con huella o rostro'}
    </Button>
  );
}

async function registerHere(): Promise<boolean> {
  try {
    const { challengeId, options } = await api.post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/auth/passkeys/register/options');
    const response = await startRegistration({ optionsJSON: options });
    await api.post('/auth/passkeys/register', { challengeId, response, deviceName: deviceName() });
    toast.success('Listo: la próxima vez puede entrar sin contraseña.');
    return true;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'InvalidStateError') toast.error('Este dispositivo ya tiene una llave de acceso registrada.');
    else if (!cancelled(e)) toast.error(e instanceof ApiError ? errorMessage(e) : 'No se pudo crear la llave de acceso en este dispositivo.');
    return false;
  }
}

interface PasskeyRow { id: string; deviceName: string; createdAt: string; lastUsedAt: string | null }

/** Tarjeta de Mi perfil: lista, activa y quita llaves de acceso. */
export function PasskeysCard() {
  const [items, setItems] = useState<PasskeyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const load = useCallback(async () => setItems(await api.get<PasskeyRow[]>('/auth/passkeys').catch(() => [])), []);
  useEffect(() => { setSupported(browserSupportsWebAuthn()); void load(); }, [load]);
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title={<span className="flex items-center gap-2"><BiometricIcon className="size-5 text-teal-600" /> Face ID, huella o Windows Hello</span>}
        description="Entre sin contraseña ni código: el teléfono o la computadora le pide su rostro, huella o PIN. Regístrelo en cada dispositivo que use. Cuenta como verificación en dos pasos."
      />
      <CardBody className="space-y-3">
        {items?.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {items.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">{p.deviceName}</p>
                  <p className="text-xs text-muted">Creada {formatDateTime(p.createdAt)}{p.lastUsedAt ? ` · usada ${formatDateTime(p.lastUsedAt)}` : ''}</p>
                </div>
                <Button size="icon" variant="ghost" aria-label={`Quitar ${p.deviceName}`} onClick={async () => {
                  if (!confirm(`¿Quitar la llave de acceso de ${p.deviceName}?`)) return;
                  try { await api.del(`/auth/passkeys/${p.id}`); toast.success('Llave de acceso eliminada'); await load(); } catch (e) { toast.error(errorMessage(e)); }
                }}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        ) : items && <p className="text-sm text-muted">Aún no tiene llaves de acceso.</p>}
        {supported
          ? <Button variant="success" loading={busy} onClick={async () => { setBusy(true); if (await registerHere()) await load(); setBusy(false); }}><BiometricIcon /> Activar en este dispositivo</Button>
          : <p className="text-sm text-muted">Este navegador no admite llaves de acceso.</p>}
      </CardBody>
    </Card>
  );
}

/** Sugerencia en el panel cuando el equipo tiene Face ID/huella y el usuario aún no tiene llave. */
export function PasskeySuggestion() {
  const [show, setShow] = useState(false);
  const [apple, setApple] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try { dismissed = localStorage.getItem('mg_passkey_hint') === 'no'; } catch { /* sin almacenamiento */ }
    setApple(isApple());
    if (dismissed || !browserSupportsWebAuthn()) return;
    void (async () => {
      if (!(await platformAuthenticatorIsAvailable())) return;
      const list = await api.get<PasskeyRow[]>('/auth/passkeys').catch(() => null);
      if (list && list.length === 0) setShow(true);
    })();
  }, []);
  if (!show) return null;
  const dismiss = () => { try { localStorage.setItem('mg_passkey_hint', 'no'); } catch { /* sin almacenamiento */ } setShow(false); };
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-teal-200 bg-teal-50 p-4">
      <BiometricIcon className="size-6 text-teal-700" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-navy-900">{apple ? 'Entre con Face ID' : 'Entre con su huella o rostro'}</p>
        <p className="text-xs text-slate-600">Más rápido y más seguro que escribir la contraseña.</p>
      </div>
      <Button variant="success" size="sm" loading={busy} onClick={async () => { setBusy(true); if (await registerHere()) setShow(false); setBusy(false); }}>Activar</Button>
      <button className="rounded-lg p-1.5 text-slate-500 hover:bg-white" onClick={dismiss} aria-label="No mostrar más"><X className="size-4" /></button>
    </div>
  );
}
