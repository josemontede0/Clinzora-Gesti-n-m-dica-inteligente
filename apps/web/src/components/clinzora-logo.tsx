import Image from 'next/image';

type Variant = 'horizontal' | 'horizontal-sin-slogan' | 'vertical' | 'icono';

/** Proporciones (ancho/alto) de los viewBox de los SVG oficiales en public/brand. */
const RATIO: Record<Variant, number> = {
  horizontal: 734 / 198,
  'horizontal-sin-slogan': 734 / 198,
  vertical: 567 / 387,
  icono: 1,
};

function file(variant: Variant, theme: 'light' | 'dark') {
  const base = variant === 'icono' ? 'clinzora-icono' : `clinzora-logo-${variant}`;
  // La variante sin slogan no tiene versión blanca: en fondo oscuro se usa la horizontal blanca.
  if (theme === 'dark') return variant === 'horizontal-sin-slogan' ? '/brand/clinzora-logo-horizontal-blanco.svg' : `/brand/${base}-blanco.svg`;
  return `/brand/${base}.svg`;
}

/** Logo oficial de Clinzora. Los SVG no se modifican (ver clinzora-brand/BRAND.md). */
export function ClinzoraLogo({ variant = 'horizontal-sin-slogan', theme = 'light', height = 36, className, priority }: {
  variant?: Variant;
  theme?: 'light' | 'dark';
  height?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src={file(variant, theme)}
      alt="Clinzora"
      height={height}
      width={Math.round(height * RATIO[variant])}
      className={className}
      priority={priority}
      unoptimized
    />
  );
}
