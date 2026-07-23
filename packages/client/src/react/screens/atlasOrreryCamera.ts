import { useCallback, useRef, useState, type PointerEvent } from 'react';
import {
  IDENTITY_VIEW,
  ORRERY,
  ZOOM_MAX,
  ZOOM_MIN,
  type ViewTransform,
  clientToViewBox,
  panView,
  zoomView,
} from './atlasOrreryGeometry.js';

// The orrery's pan/zoom camera (issue #519), lifted out of AtlasRelationsTab so
// the tab stays about graph state. `view` is a lens over the chart body, never a
// layout change — the geometry beneath it is fixed (see ViewTransform / the
// camera invariant in atlasOrreryGeometry.ts). Drag pan and click re-centre
// share the svg, so a live drag records `draggedRef`; the tab's node-activation
// guard calls `consumeDrag()` to swallow the click that a drag would otherwise
// fire (a pan should not teleport the centre).

const DRAG_THRESHOLD = 3; // px — below this a pointer press stays a click

export interface OrreryCamera {
  /** The current camera transform, applied to the chart's single viewport `<g>`. */
  view: ViewTransform;
  /** Snap the camera back to identity — used on re-centre and on a fresh graph
   *  (travelling re-frames) and by the reset control. */
  resetView: () => void;
  /** Consume a just-finished drag: returns true (and clears the flag) when the
   *  preceding pointer sequence was a pan, so the trailing click is swallowed. */
  consumeDrag: () => boolean;
  /** Zoom about the viewBox centre by a multiplicative factor (the +/− controls). */
  zoomBy: (factor: number) => void;
  /** Raw pointer/wheel handlers for the svg. `onWheel` is bound natively (with
   *  `{ passive: false }`) in the chart so preventDefault bites; the rest are
   *  ordinary React pointer props. */
  handlers: {
    onWheel: (ev: WheelEvent) => void;
    onPointerDown: (ev: PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (ev: PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (ev: PointerEvent<SVGSVGElement>) => void;
  };
}

export function useOrreryCamera(): OrreryCamera {
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    scale: number;
  } | null>(null);
  const draggedRef = useRef(false);

  const resetView = useCallback(() => setView(IDENTITY_VIEW), []);

  const consumeDrag = useCallback((): boolean => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return true;
    }
    return false;
  }, []);

  // Wheel zoom about the cursor. Native WheelEvent (bound with passive:false in
  // the chart) so preventDefault stops the page scrolling. If the rect is
  // degenerate (jsdom), clientToViewBox is null → zoom about the canvas centre.
  const onWheel = useCallback((ev: WheelEvent) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const target = ev.currentTarget as SVGSVGElement | null;
    const rect = target?.getBoundingClientRect();
    const p = rect ? clientToViewBox(rect, ORRERY.view, ev.clientX, ev.clientY) : null;
    setView((v) => zoomView(v, p?.x ?? ORRERY.cx, p?.y ?? ORRERY.cy, factor, ZOOM_MIN, ZOOM_MAX));
  }, []);

  const onPointerDown = useCallback((ev: PointerEvent<SVGSVGElement>) => {
    if (ev.button !== 0) return; // primary button / touch contact only
    draggedRef.current = false;
    const rect = ev.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      moved: false,
      // client px → viewBox units: the square viewBox fills the svg's width.
      scale: rect.width > 0 ? ORRERY.view / rect.width : 1,
    };
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  }, []);

  const onPointerMove = useCallback((ev: PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.id) return;
    if (!d.moved) {
      // Hold as a click until the pointer travels past the threshold.
      if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.moved = true;
      draggedRef.current = true;
    }
    const dvx = (ev.clientX - d.lastX) * d.scale;
    const dvy = (ev.clientY - d.lastY) * d.scale;
    d.lastX = ev.clientX;
    d.lastY = ev.clientY;
    setView((v) => panView(v, dvx, dvy));
  }, []);

  const onPointerUp = useCallback((ev: PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.id) return;
    ev.currentTarget.releasePointerCapture?.(ev.pointerId);
    dragRef.current = null;
    // draggedRef intentionally left set — the trailing click is swallowed by the
    // tab's node-activation guard (consumeDrag), and the next pointerdown clears it.
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setView((v) => zoomView(v, ORRERY.cx, ORRERY.cy, factor, ZOOM_MIN, ZOOM_MAX));
  }, []);

  return {
    view,
    resetView,
    consumeDrag,
    zoomBy,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp },
  };
}
