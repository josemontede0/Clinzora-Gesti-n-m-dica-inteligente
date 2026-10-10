'use client';

import { AuditTab, FiscalTab, RolesTab, UsersTab } from '@/components/settings/access-tabs';
import { BranchesTab } from '@/components/settings/branches-tab';
import { OrganizationTab } from '@/components/settings/organization-tab';
import { ProfessionalsTab } from '@/components/settings/professionals-tab';
import { ServicesTab } from '@/components/settings/services-tab';
import { PageHeader } from '@/components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';
import { usePersistentState } from '@/lib/use-api';

export default function SettingsPage() {
  const { can, canAny } = useSession();
  const tabs = [
    { key: 'organizacion', label: 'Organización', show: can('settings.read'), el: <OrganizationTab /> },
    { key: 'sucursales', label: 'Sucursales y caja', show: canAny('settings.read', 'catalogs.manage'), el: <BranchesTab /> },
    { key: 'medicos', label: 'Médicos y horarios', show: canAny('catalogs.manage', 'schedules.manage'), el: <ProfessionalsTab /> },
    { key: 'servicios', label: 'Servicios, tarifas y ARS', show: canAny('catalogs.manage', 'insurance.manage'), el: <ServicesTab /> },
    { key: 'fiscal', label: 'Fiscal', show: can('fiscal.manage'), el: <FiscalTab /> },
    { key: 'usuarios', label: 'Usuarios', show: can('users.read'), el: <UsersTab /> },
    { key: 'roles', label: 'Roles y permisos', show: can('users.read'), el: <RolesTab /> },
    { key: 'auditoria', label: 'Auditoría', show: can('audit.read'), el: <AuditTab /> },
  ].filter((t) => t.show);
  const [state, setState] = usePersistentState('mg_settings_tab', { tab: tabs[0]?.key ?? 'organizacion' });
  const active = tabs.some((t) => t.key === state.tab) ? state.tab : tabs[0]?.key;

  return (
    <>
      <PageHeader title="Configuración" description="Parámetros del sistema, catálogos, accesos y auditoría. Los cambios sensibles quedan auditados." />
      <Tabs value={active} onValueChange={(tab) => setState({ tab })}>
        <TabsList>{tabs.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}</TabsList>
        {tabs.map((t) => <TabsContent key={t.key} value={t.key}>{t.el}</TabsContent>)}
      </Tabs>
    </>
  );
}
