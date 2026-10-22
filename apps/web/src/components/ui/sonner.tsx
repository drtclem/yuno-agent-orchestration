import { Toaster as Sonner } from 'sonner';

// shadcn's Sonner pattern: https://ui.shadcn.com/docs/components/sonner
export function Toaster({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <Sonner theme={theme} closeButton richColors position="bottom-right" />
  );
}
