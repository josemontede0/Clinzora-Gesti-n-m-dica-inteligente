'use client';

import { useEffect, useState } from 'react';

export interface StationConfig {
  station: string;
  areaIds: string[];
}

const KEY = 'mg_queue_station';

/** Puesto de atención del equipo (se recuerda en este navegador): nombre y áreas que atiende. */
export function useStation(): [StationConfig, (c: StationConfig) => void] {
  const [config, setConfig] = useState<StationConfig>({ station: '', areaIds: [] });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setConfig({ station: '', areaIds: [], ...JSON.parse(raw) });
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  const save = (c: StationConfig) => {
    setConfig(c);
    try {
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch {
      /* sin almacenamiento */
    }
  };
  return [config, save];
}

export interface QueueArea {
  id: string;
  branchId: string;
  code: string;
  name: string;
  autoCheckin: boolean;
  sortOrder: number;
  active: boolean;
}

export interface QueueTicket {
  id: string;
  code: string;
  number: number;
  status: 'ESPERANDO' | 'LLAMADO' | 'ATENDIENDO' | 'ATENDIDO' | 'NO_SE_PRESENTO' | 'CANCELADO';
  priority: boolean;
  priorityReason: string | null;
  station: string | null;
  calledCount: number;
  calledAt: string | null;
  createdAt: string;
  appointmentId: string | null;
  visitorName: string | null;
  area: { id: string; code: string; name: string };
  patient: { id: string; firstName: string; lastName: string; recordNumber: string } | null;
}

export function minutesSince(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
