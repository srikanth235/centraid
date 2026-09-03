import { useCallback, useRef, useState } from "react";
import type { PointerEvent } from "react";

import {
  IDENTITY_VIEW,
  ORRERY,
  ZOOM_MAX,
  ZOOM_MIN,
  clientToViewBox,
  panView,
  zoomView,
} from "./atlasOrreryGeometry.js";
import type { ViewTransform } from "./atlasOrreryGeometry.js";

const DRAG_THRESHOLD = 3; // px — under this a press stays a click

export interface OrreryCamera {
  view: ViewTransform;
  resetView: () => void;
  consumeDrag: () => boolean;
  zoomBy: (factor: number) => void;
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

  const onWheel = useCallback((ev: WheelEvent) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const target = ev.currentTarget as SVGSVGElement | null;
    const rect = target?.getBoundingClientRect();
    const p = rect
      ? clientToViewBox(rect, ORRERY.view, ev.clientX, ev.clientY)
      : null;
    setView((v) =>
      zoomView(
        v,
        p?.x ?? ORRERY.cx,
        p?.y ?? ORRERY.cy,
        factor,
        ZOOM_MIN,
        ZOOM_MAX
      )
    );
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
      scale: rect.width > 0 ? ORRERY.view / rect.width : 1,
    };
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  }, []);

  const onPointerMove = useCallback((ev: PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.id) return;
    if (!d.moved) {
      if (
        Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) <
        DRAG_THRESHOLD
      )
        return;
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
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setView((v) =>
      zoomView(v, ORRERY.cx, ORRERY.cy, factor, ZOOM_MIN, ZOOM_MAX)
    );
  }, []);

  return {
    view,
    resetView,
    consumeDrag,
    zoomBy,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp },
  };
}
