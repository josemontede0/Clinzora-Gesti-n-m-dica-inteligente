'use client';

import { Loader2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppShell } from '@/components/app-shell';
import { SessionProvider, useSession } from '@/lib/session';

function Gate({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!me) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (me.mfaPending) router.replace(`/login?mfa=1&next=${encodeURIComponent(pathname)}`);
    else if ((me.mustChangePassword || me.mfaSetupRequired) && pathname !== '/perfil') router.replace('/perfil?obligatorio=1');
  }, [loading, me, pathname, router]);

  if (loading || !me || me.mfaPending) {
    return (
      <div className="grid min-h-dvh place-items-center text-muted">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Cargando" />
      </div>
    );
  }
  return <AppShell>{children}</AppShell>;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
