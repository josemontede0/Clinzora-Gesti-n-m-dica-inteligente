import * as LabelPrimitive from '@radix-ui/react-label';
import * as React from 'react';
import { cn } from '@/lib/utils';

const field = 'w-full rounded-lg border border-border bg-white px-3 text-sm text-slate-800 placeholder:text-slate-400 shadow-xs transition-colors focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:border-red-400';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, 'h-10', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-[88px] py-2 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

/** Select nativo: accesible y usable en móviles (selector del sistema). */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(field, 'mg-select h-10 pr-9', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';

export const Label = React.forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-[13px] font-medium text-slate-700', className)} {...props} />
));
Label.displayName = 'Label';

export function Field({ label, error, hint, required, children, className, htmlFor }: { label?: string; error?: string; hint?: string; required?: boolean; children: React.ReactNode; className?: string; htmlFor?: string }) {
  // Asocia la etiqueta con el control (accesibilidad y pruebas por etiqueta) aunque no se pase htmlFor.
  const autoId = React.useId();
  const child = React.isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) ? children : null;
  const id = htmlFor ?? child?.props.id ?? autoId;
  const messageId = `${id}-msg`;
  const content = child && !child.props.id ? React.cloneElement(child, { id, 'aria-describedby': error || hint ? messageId : undefined }) : children;
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </Label>
      )}
      {content}
      {error ? <p id={messageId} className="text-xs text-red-600">{error}</p> : hint ? <p id={messageId} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, className, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2 text-sm text-slate-700', className)}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-teal-600" {...props} />
      <span>{label}</span>
    </label>
  );
}
