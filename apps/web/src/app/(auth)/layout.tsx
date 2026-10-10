import { Activity, CalendarCheck, ShieldCheck, Wallet } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(440px,520px)]">
      <section className="relative hidden overflow-hidden bg-navy-800 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-teal-500/10" />
        <div className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-white/5" />
        <div className="relative flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-teal-500"><Activity className="h-6 w-6" /></span>
          <span className="text-lg font-semibold">MediGest</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">Gestión clínica, administrativa y financiera en un solo lugar.</h1>
          <ul className="mt-8 space-y-4 text-navy-100">
            <li className="flex gap-3"><CalendarCheck className="h-5 w-5 shrink-0 text-teal-400" /> Agenda, recepción y recordatorios.</li>
            <li className="flex gap-3"><ShieldCheck className="h-5 w-5 shrink-0 text-teal-400" /> Expediente clínico con control de acceso y auditoría.</li>
            <li className="flex gap-3"><Wallet className="h-5 w-5 shrink-0 text-teal-400" /> Facturación, caja, seguros y conciliación.</li>
          </ul>
        </div>
        <p className="relative text-xs text-navy-200">Acceso exclusivo para personal autorizado. Toda actividad queda registrada.</p>
      </section>
      <section className="flex items-center justify-center bg-white px-5 py-10 sm:px-10">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}
