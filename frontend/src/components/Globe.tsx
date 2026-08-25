import { useEffect, useRef, useState } from 'react';
import createGlobe from 'cobe';
import type { AllocationBreakdown } from '@decisionguru/shared';

interface Props {
  allocation: AllocationBreakdown;
  size?: number;
}

const TWO_PI = Math.PI * 2;

/**
 * cobe globe with gold markers sized by allocation weight. Click-and-drag to rotate
 * (both axes); auto-spin pauses while dragging and resumes on release. On open it
 * orients to the heaviest-weighted country so the primary marker faces the viewer —
 * markers are always drawn, so you never have to wait for the spin to bring one around.
 */
export function Globe({ allocation, size = 300 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);

  const marked = allocation.countries.filter((c) => c.lat != null && c.lng != null);
  const markers = marked.map((c) => ({
    location: [c.lat as number, c.lng as number] as [number, number],
    size: Math.max(0.04, Math.min(0.14, Math.sqrt(c.weight) * 0.14)),
  }));
  // Heaviest country decides the opening orientation.
  const primary = marked.slice().sort((a, b) => b.weight - a.weight)[0];
  const initialPhi = primary ? ((-(primary.lng as number) * Math.PI) / 180 + TWO_PI) % TWO_PI : 0;
  const initialTheta = primary ? Math.max(-0.5, Math.min(0.6, ((primary.lat as number) * Math.PI) / 180 * 0.6)) : 0.25;

  // Refs so the render loop reads live values without re-creating the globe.
  const phi = useRef(initialPhi);
  const theta = useRef(initialTheta);
  const draggingRef = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const width = size;
    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: initialPhi,
      theta: initialTheta,
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 5,
      baseColor: [0.16, 0.33, 0.5],
      markerColor: [0.85, 0.66, 0.3],
      glowColor: [0.1, 0.32, 0.55],
      markers,
      onRender: (state) => {
        if (!draggingRef.current) phi.current += 0.004; // gentle auto-spin when idle
        state.phi = phi.current;
        state.theta = theta.current;
        state.width = width * 2;
        state.height = width * 2;
      },
    });
    return () => globe.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, JSON.stringify(markers)]);

  const onDown = (clientX: number, clientY: number) => {
    pointer.current = { x: clientX, y: clientY };
    draggingRef.current = true;
    setDragging(true);
  };
  const onMove = (clientX: number, clientY: number) => {
    if (!pointer.current) return;
    const dx = clientX - pointer.current.x;
    const dy = clientY - pointer.current.y;
    pointer.current = { x: clientX, y: clientY };
    phi.current -= dx / 120;
    theta.current = Math.max(-1.2, Math.min(1.2, theta.current + dy / 120));
  };
  const onUp = () => {
    pointer.current = null;
    draggingRef.current = false;
    setDragging(false);
  };

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Geographic allocation globe — drag to rotate"
      style={{
        width: size,
        height: size,
        maxWidth: '100%',
        aspectRatio: '1',
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        onDown(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => onMove(e.clientX, e.clientY)}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    />
  );
}
