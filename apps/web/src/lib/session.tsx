'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PermissionCode } from '@medigest/shared';
import { api } from './api';

export interface Me {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: PermissionCode[];
  professionalId: string | null;
  mfaEnabled: boolean;
  mfaPending: boolean;
  mfaSetupRequired: boolean;
  mustChangePassword: boolean;
  organization: { id: string; name: string; currency: string; timezone: string; logoFileId: string | null };
  productName: string;
  timeFormat24h: boolean;
  allowVirtualAppointments: boolean;
  branches: { id: string; code: string; name: string }[];
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  can: (...codes: PermissionCode[]) => boolean;
  canAny: (...codes: PermissionCode[]) => boolean;
  branchId: string;
  setBranchId: (id: string) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [branchId, setBranchIdState] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<Me>('/auth/me');
      setMe(data);
      const stored = typeof window !== 'undefined' ? localStorage.getItem('mg_branch') : null;
      const valid = data.branches.find((b) => b.id === stored)?.id ?? data.branches[0]?.id ?? '';
      setBranchIdState(valid);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setBranchId = (id: string) => {
    setBranchIdState(id);
    try {
      localStorage.setItem('mg_branch', id);
    } catch {
      /* sin almacenamiento */
    }
  };

  const can = (...codes: PermissionCode[]) => !!me && codes.every((c) => me.permissions.includes(c));
  const canAny = (...codes: PermissionCode[]) => !!me && codes.some((c) => me.permissions.includes(c));

  return <Ctx.Provider value={{ me, loading, can, canAny, branchId, setBranchId, refresh }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession fuera de SessionProvider');
  return ctx;
}
