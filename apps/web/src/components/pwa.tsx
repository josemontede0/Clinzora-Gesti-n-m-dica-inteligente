'use client';

import { Download, Share } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Registra el service worker (solo en producción y con HTTPS o localhost). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}

/**
 * Botón "Instalar app". En Chrome/Edge/Android usa el aviso nativo de instalación; en iPhone/iPad
 * (Safari no lo ofrece) explica cómo agregarla a la pantalla de inicio. Se oculta si ya está instalada.
 */
export function InstallAppButton({ className }: { className?: string }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || (!deferred && !ios)) return null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={className}
        onClick={async () => {
          if (deferred) {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          } else setIosHelp(true);
        }}
      >
        <Download /> Instalar app
      </Button>
      <Dialog open={iosHelp} onOpenChange={setIosHelp} title="Instalar Clinzora en iPhone o iPad" size="sm">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Abra esta página en <b>Safari</b>.</li>
          <li>Toque el botón <b>Compartir</b> <Share className="inline h-4 w-4" />.</li>
          <li>Elija <b>Agregar a pantalla de inicio</b> y confirme.</li>
        </ol>
      </Dialog>
    </>
  );
}
