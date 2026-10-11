'use client';

import { Maximize, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClinzoraLogo } from '@/components/clinzora-logo';

interface PublicTicket { id: string; code: string; area: string; station: string | null; status: string; calledAt: string | null; calledCount: number; priority: boolean; name: string | null }
interface Display {
  organization: string;
  branch: string;
  timezone: string;
  serverTime: string;
  current: PublicTicket | null;
  recent: PublicTicket[];
  waitingByArea: { area: string; code: string; waiting: number }[];
}

const SOUND_KEY = 'mg_display_sound';

/** Turno en palabras para la voz: "C-012" → "C doce". */
function spoken(code: string) {
  const [prefix, num] = code.split('-');
  return `${prefix.split('').join(' ')} ${Number(num)}`;
}

/** Aviso sonoro corto (dos tonos) sin archivos de audio. */
function chime(ctx: AudioContext) {
  const now = ctx.currentTime;
  [880, 660].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.35, now + i * 0.35 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.35 + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.35);
    osc.stop(now + i * 0.35 + 0.55);
  });
}

/**
 * Pantalla de turnos para la recepción (TV o monitor). Se abre con el enlace secreto generado en
 * Configuración > Turnos; no requiere iniciar sesión y solo muestra códigos de turno y puestos.
 */
export default function DisplayPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Display | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [flash, setFlash] = useState(false);
  const [now, setNow] = useState(new Date());
  const lastKey = useRef<string | null>(null);
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      setSoundOn(localStorage.getItem(SOUND_KEY) === '1');
    } catch {
      /* sin almacenamiento */
    }
  }, []);

  const announce = useCallback(
    (t: PublicTicket) => {
      setFlash(true);
      setTimeout(() => setFlash(false), 6000);
      if (!soundOn) return;
      try {
        audio.current ??= new AudioContext();
        chime(audio.current);
      } catch {
        /* sin audio */
      }
      if ('speechSynthesis' in window) {
        const msg = new SpeechSynthesisUtterance(`Turno ${spoken(t.code)}${t.name ? `, ${t.name}` : ''}. Pase a ${t.station ?? t.area}.`);
        msg.lang = 'es-ES';
        msg.rate = 0.95;
        const voice = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith('es'));
        if (voice) msg.voice = voice;
        setTimeout(() => window.speechSynthesis.speak(msg), 900);
      }
    },
    [soundOn],
  );

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/backend/public/display/${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (alive) setError('Esta pantalla no existe o su enlace fue revocado. Genere uno nuevo en Configuración > Turnos.');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as Display;
        if (!alive) return;
        setOffline(false);
        setError(null);
        setData(d);
        const key = d.current ? `${d.current.id}:${d.current.calledCount}` : null;
        if (key && lastKey.current !== null && key !== lastKey.current && d.current) announce(d.current);
        lastKey.current = key ?? '';
      } catch {
        if (alive) setOffline(true);
      }
    };
    void load();
    const poll = setInterval(load, 3000);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [token, announce]);

  const toggleSound = () => {
    const v = !soundOn;
    setSoundOn(v);
    try {
      localStorage.setItem(SOUND_KEY, v ? '1' : '0');
    } catch {
      /* sin almacenamiento */
    }
    if (v) {
      // El navegador exige un clic para habilitar el audio: se prueba el aviso en ese momento.
      try {
        audio.current ??= new AudioContext();
        void audio.current.resume();
        chime(audio.current);
      } catch {
        /* sin audio */
      }
    }
  };

  const tz = data?.timezone ?? 'America/Santo_Domingo';
  const time = new Intl.DateTimeFormat('es-DO', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(now);
  const date = new Intl.DateTimeFormat('es-DO', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now);

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-navy-900 p-10 text-center text-white">
        <div>
          <ClinzoraLogo variant="vertical" theme="dark" height={140} />
          <p className="mt-8 max-w-xl text-xl text-navy-100">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-navy-900 text-white">
      <header className="flex items-center justify-between gap-6 px-10 py-6">
        <div className="flex items-center gap-6">
          <ClinzoraLogo variant="horizontal-sin-slogan" theme="dark" height={56} priority />
          <div className="border-l border-white/15 pl-6">
            <p className="text-2xl font-semibold">{data?.organization ?? ''}</p>
            <p className="text-lg text-navy-200">{data?.branch ?? ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-5xl font-semibold tabular-nums">{time}</p>
            <p className="text-lg text-navy-200 first-letter:uppercase">{date}</p>
          </div>
          <div className="flex flex-col gap-2">
            <button onClick={toggleSound} className="rounded-lg bg-white/10 p-2 hover:bg-white/20" aria-label={soundOn ? 'Silenciar' : 'Activar sonido'} title={soundOn ? 'Silenciar' : 'Activar sonido'}>
              {soundOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
            </button>
            <button onClick={() => void document.documentElement.requestFullscreen?.()} className="rounded-lg bg-white/10 p-2 hover:bg-white/20" aria-label="Pantalla completa" title="Pantalla completa">
              <Maximize className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      {!soundOn && (
        <button onClick={toggleSound} className="mx-10 mb-2 rounded-xl bg-amber-400/15 px-6 py-3 text-left text-lg text-amber-200 ring-1 ring-amber-300/30">
          Toque aquí para activar el sonido y la voz de los llamados.
        </button>
      )}
      {offline && (
        <div className="mx-10 mb-2 flex items-center gap-3 rounded-xl bg-red-500/15 px-6 py-3 text-lg text-red-200 ring-1 ring-red-400/30">
          <WifiOff className="h-5 w-5" /> Sin conexión. Reintentando…
        </div>
      )}

      <section className="grid flex-1 grid-cols-1 gap-8 px-10 pb-6 xl:grid-cols-[1.6fr_1fr]">
        <div
          className={`flex flex-col items-center justify-center rounded-3xl p-10 text-center ring-1 transition-colors duration-500 ${flash ? 'bg-teal-500/25 ring-teal-300/60' : 'bg-white/5 ring-white/10'}`}
          aria-live="assertive"
        >
          {data?.current ? (
            <>
              <p className="text-3xl font-medium uppercase tracking-[0.2em] text-teal-300">Turno</p>
              <p className={`my-4 font-bold leading-none tracking-tight ${flash ? 'animate-pulse' : ''}`} style={{ fontSize: 'clamp(6rem, 16vw, 15rem)' }}>{data.current.code}</p>
              {data.current.name && <p className="mb-2 text-4xl text-navy-100">{data.current.name}</p>}
              <p className="text-4xl text-navy-100">Pase a</p>
              <p className="mt-2 text-6xl font-semibold text-white">{data.current.station ?? data.current.area}</p>
              {data.current.priority && <p className="mt-6 rounded-full bg-amber-400/20 px-5 py-1.5 text-2xl text-amber-200">Prioritario</p>}
            </>
          ) : (
            <p className="text-4xl text-navy-200">Esperando el próximo llamado…</p>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex-1 rounded-3xl bg-white/5 p-6 ring-1 ring-white/10">
            <p className="mb-4 text-2xl font-semibold text-navy-100">Últimos llamados</p>
            {data?.recent.length ? (
              <ul className="space-y-3">
                {data.recent.map((t) => (
                  <li key={t.id} className="flex items-center justify-between rounded-2xl bg-white/5 px-5 py-4">
                    <span className="text-4xl font-bold tabular-nums">{t.code}</span>
                    <span className="text-right text-2xl text-navy-100">{t.station ?? t.area}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xl text-navy-200">—</p>}
          </div>
          <div className="rounded-3xl bg-white/5 p-6 ring-1 ring-white/10">
            <p className="mb-4 text-2xl font-semibold text-navy-100">En espera</p>
            <div className="grid grid-cols-2 gap-3">
              {data?.waitingByArea.map((a) => (
                <div key={a.code} className="rounded-2xl bg-white/5 px-5 py-3">
                  <p className="text-lg text-navy-200">{a.area}</p>
                  <p className="text-4xl font-bold tabular-nums">{a.waiting}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="px-10 pb-5 text-sm text-navy-200">Clinzora · un producto de KonviaRD</footer>
    </main>
  );
}
