import { useEffect, useState } from 'react';

/** The value, updated at most once per `delay` ms of quiet — keeps live filtering smooth
 *  while a slider is being dragged without an apply button. */
export function useDebounced<T>(value: T, delay = 100): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
