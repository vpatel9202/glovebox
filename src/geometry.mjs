// The image space a model sees for a window, and the mapping back to screen points.
//
// Image pixels are window-local: (0, 0) is the window's top-left corner. One
// view's scale `s` is image pixels per screen point. It depends only on the
// window size, the display's backing scale, and the configured limits, so the
// AX tree, screenshots, and clicks all agree even before any screenshot exists.

export function viewFor(window, limits) {
  const [x, y, w, h] = window.frame;
  const backing = window.scale || 1;
  const s = Math.min(
    backing,
    limits.maxLongSide / Math.max(w, h),
    Math.sqrt(limits.maxPixels / Math.max(1, w * h)),
  );
  return {
    window: window.index,
    windowId: window.windowId,
    title: window.title,
    origin: [x, y],
    size: [w, h],
    scale: s,
    width: Math.max(1, Math.round(w * s)),
    height: Math.max(1, Math.round(h * s)),
  };
}

export function toScreen(view, [ix, iy]) {
  return [view.origin[0] + ix / view.scale, view.origin[1] + iy / view.scale];
}

export function toImage(view, [sx, sy, sw, sh]) {
  return [(sx - view.origin[0]) * view.scale, (sy - view.origin[1]) * view.scale, sw * view.scale, sh * view.scale];
}

export function center([x, y, w, h]) {
  return [x + w / 2, y + h / 2];
}
