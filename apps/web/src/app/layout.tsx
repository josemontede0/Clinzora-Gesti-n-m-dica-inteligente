import type { Metadata, Viewport } from 'next';
import { Poppins } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

const poppins = Poppins({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-poppins', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Clinzora — Gestión médica inteligente', template: '%s · Clinzora' },
  description: 'Tecnología para una mejor salud. Pacientes, citas, facturación y seguros médicos en una sola plataforma.',
  applicationName: 'Clinzora',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B2E4F' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-DO" className={poppins.variable}>
      <body>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
