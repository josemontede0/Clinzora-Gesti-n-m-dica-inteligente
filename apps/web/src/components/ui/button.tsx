import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-blue-500 text-white hover:bg-blue-600 shadow-sm',
        dark: 'bg-navy-800 text-white hover:bg-navy-700 shadow-sm',
        success: 'bg-teal-700 text-white hover:bg-teal-800 shadow-sm',
        outline: 'border border-border bg-white text-slate-700 hover:bg-slate-50',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        destructive: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
        link: 'text-blue-500 underline-offset-4 hover:underline px-0',
      },
      size: {
        default: 'h-10 px-4',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {asChild ? children : (
        <>
          {loading && <Loader2 className="animate-spin" />}
          {children}
        </>
      )}
    </Comp>
  );
});
Button.displayName = 'Button';

export { buttonVariants };
