import { createContext } from 'react';
import type { useEvents } from './api/use-events.js';
export const LiveEventsContext = createContext<ReturnType<
  typeof useEvents
> | null>(null);
