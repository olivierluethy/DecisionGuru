import { useEffect, useRef } from 'react';
import createGlobe from 'cobe';
import type { AllocationBreakdown } from '@decisionguru/shared';

interface Props {
  allocation: AllocationBreakdown;
  size?: number;
}

/** Rotating cobe globe with gold markers sized by geographic allocation weight. */
export function Globe({ allocation, size = 300 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phiRef = useRef(0);

  const markers = allocation.countries
    .filter((c) => c.lat != null && c.lng != null)
    .map((c) => ({
      location: [c.lat as number, c.lng as number] as [number, number],
      size: Math.max(0.03, Math.min(0.14, Math.sqrt(c.weight) * 0.14)),
    }));

  useEffect(() => {
    if (!canvasRef.current) return;
    let width = size;
    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: 0,
      theta: 0.25,
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 5,
      baseColor: [0.16, 0.33, 0.5],
      markerColor: [0.85, 0.66, 0.3],
      glowColor: [0.1, 0.32, 0.55],
      markers,
      onRender: (state) => {
        state.phi = phiRef.current;
        phiRef.current += 0.004;
        state.width = width * 2;
        state.height = width * 2;
      },
    });
    return () => globe.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, JSON.stringify(markers)]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, maxWidth: '100%', aspectRatio: '1' }}
      aria-label="Geographic allocation globe"
    />
  );
}
