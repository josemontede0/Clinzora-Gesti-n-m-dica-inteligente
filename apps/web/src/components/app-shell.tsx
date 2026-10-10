'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { PermissionCode } from '@medigest/shared';
import {
  BarChart3, Bell, CalendarDays, ChevronsLeft, ChevronsRight, ClipboardList, FileText, LayoutDashboard, LogOut, Menu, Settings, ShieldCheck, UserRound, Users, Wallet, X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { t, type MessageKey } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { ClinzoraLogo } from './clinzora-logo';
import { PatientSearch } from './patient-search';
import { InstallAppButton } from './pwa';

interface NavItem {
  href: string;
  label: MessageKey;
  icon: React.ComponentType<{ className?: string }>;
  any: PermissionCode[];
  group: MessageKey;
}

const NAV: NavItem[] = [
  { href: '/', label: 'nav.dashboard', icon: LayoutDashboard, any: ['reports.operational', 'reports.financial', 'appointments.read'], group: 'nav.group.operation' },
  { href: '/recepcion', label: 'nav.reception', icon: ClipboardList, any: ['appointments.read'], group: 'nav.group.operation' },
  { href: '/agenda', label: 'nav.agenda', icon: CalendarDays, any: ['appointments.read'], group: 'nav.group.operation' },
  { href: '/pacientes', label: 'nav.patients', icon: Users, any: ['patients.read'], group: 'nav.group.operation' },
  { href: '/facturacion', label: 'nav.billing', icon: FileText, any: ['billing.read'], group: 'nav.group.finance' },
  { href: '/caja', label: 'nav.cash', icon: Wallet, any: ['cash.operate', 'cash.supervise'], group: 'nav.group.finance' },
  { href: '/seguros', label: 'nav.insurance', icon: ShieldCheck, any: ['insurance.read'], group: 'nav.group.finance' },
  { href: '/reportes', label: 'nav.reports', icon: BarChart3, any: ['reports.operational', 'reports.financial'], group: 'nav.group.admin' },
  { href: '/notificaciones', label: 'nav.notifications', icon: Bell, any: ['notifications.read'], group: 'nav.group.admin' },
  { href: '/configuracion', label: 'nav.settings', icon: Settings, any: ['settings.read', 'users.read', 'catalogs.manage', 'insurance.manage', 'fiscal.manage', 'audit.read'], group: 'nav.group.admin' },
];

function Brand({ collapsed }: { collapsed?: boolean }) {
  // Sobre el sidebar oscuro se usan las variantes blancas del logo (BRAND.md).
  return collapsed ? <ClinzoraLogo variant="icono" theme="dark" height={32} priority /> : <ClinzoraLogo variant="horizontal-sin-slogan" theme="dark" height={44} priority />;
}

function SideNav({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { canAny } = useSession();
  const items = NAV.filter((n) => canAny(...n.any));
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Navegación principal">
      {groups.map((g) => (
        <div key={g}>
          {!collapsed && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-navy-200/70">{t(g)}</p>}
          <ul className="space-y-0.5">
            {items.filter((i) => i.group === g).map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    title={collapsed ? t(item.label) : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active ? 'bg-white/10 text-white' : 'text-navy-100/80 hover:bg-white/5 hover:text-white',
                      collapsed && 'justify-center px-0',
                    )}
                  >
                    <Icon className={cn('h-[18px] w-[18px] shrink-0', active && 'text-teal-400')} />
                    {!collapsed && t(item.label)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, branchId, setBranchId, canAny } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [alerts, setAlerts] = useState(0);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('mg_sidebar') === '1');
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);

  // Indicador: notificaciones fallidas que requieren atención.
  useEffect(() => {
    if (!canAny('notifications.read')) return;
    api.get<{ total: number }>('/notifications', { status: 'FALLIDO', pageSize: 1 }).then((r) => setAlerts(r.total)).catch(() => undefined);
  }, [canAny, pathname]);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('mg_sidebar', c ? '0' : '1');
      } catch {
        /* sin almacenamiento */
      }
      return !c;
    });
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  };

  return (
    <div className="min-h-dvh">
      {/* Sidebar escritorio */}
      <aside className={cn('fixed inset-y-0 left-0 z-30 hidden flex-col bg-navy-800 print:!hidden transition-[width] duration-200 lg:flex', collapsed ? 'w-[72px]' : 'w-64')}>
        <div className={cn('flex h-16 items-center border-b border-white/5 px-4', collapsed && 'justify-center px-0')}>
          <Brand collapsed={collapsed} />
        </div>
        <SideNav collapsed={collapsed} />
        <button onClick={toggle} className="m-3 flex items-center justify-center gap-2 rounded-lg py-2 text-xs text-navy-200 hover:bg-white/5 hover:text-white" aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Contraer</>}
        </button>
      </aside>

      {/* Sidebar móvil */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-navy-900/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-navy-800 animate-fade-in">
            <div className="flex h-16 items-center justify-between border-b border-white/5 px-4">
              <Brand />
              <button onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 text-navy-100 hover:bg-white/10" aria-label="Cerrar menú"><X className="h-5 w-5" /></button>
            </div>
            <SideNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className={cn('transition-[padding] duration-200 print:!pl-0', collapsed ? 'lg:pl-[72px]' : 'lg:pl-64')}>
        <header className="sticky top-0 z-20 flex h-16 print:hidden items-center gap-3 border-b border-border bg-white/90 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Abrir menú"><Menu className="h-5 w-5" /></button>
          <span className="shrink-0 lg:hidden"><ClinzoraLogo variant="icono" height={28} /></span>
          {canAny('patients.read') && (
            <PatientSearch compact className="max-w-md flex-1" placeholder={t('header.search')} onSelect={(p) => router.push(`/pacientes/${p.id}`)} />
          )}
          <div className="ml-auto flex items-center gap-2">
            <InstallAppButton className="hidden md:inline-flex" />
            {me && me.branches.length > 1 && (
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label={t('header.branch')} className="hidden h-9 rounded-lg border border-border bg-white px-2 text-sm md:block">
                {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
            {canAny('notifications.read') && (
              <Link href="/notificaciones?estado=FALLIDO" className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label={`Notificaciones${alerts ? `: ${alerts} con fallo` : ''}`}>
                <Bell className="h-5 w-5" />
                {alerts > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">{alerts > 99 ? '99+' : alerts}</span>}
              </Link>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100" aria-label="Menú de usuario">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-navy-100 text-sm font-semibold text-navy-700">{me?.fullName.charAt(0) ?? '?'}</span>
                <span className="hidden max-w-[160px] truncate text-sm font-medium text-slate-700 md:block">{me?.fullName}</span>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[220px] rounded-xl border border-border bg-white p-1 shadow-lg animate-fade-in">
                  <div className="px-3 py-2">
                    <p className="truncate text-sm font-medium">{me?.fullName}</p>
                    <p className="truncate text-xs text-muted">{me?.email}</p>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item onSelect={() => router.push('/perfil')} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-slate-100">
                    <UserRound className="h-4 w-4" /> {t('header.profile')}
                  </DropdownMenu.Item>
                  {me && me.branches.length > 1 && (
                    <div className="px-3 py-2 md:hidden">
                      <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="h-9 w-full rounded-lg border border-border px-2 text-sm">
                        {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                  )}
                  <DropdownMenu.Item onSelect={logout} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 outline-none data-[highlighted]:bg-red-50">
                    <LogOut className="h-4 w-4" /> {t('header.logout')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        <footer className="mx-auto w-full max-w-[1400px] px-4 pb-6 text-xs text-[var(--cz-gray)] sm:px-6 lg:px-8 print:hidden">Clinzora · un producto de KonviaRD</footer>
      </div>
    </div>
  );
}

