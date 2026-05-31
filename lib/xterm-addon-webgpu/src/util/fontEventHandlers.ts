/**
 * IRenderer-level reactions to xterm's font-changing events. Both
 * `handleDevicePixelRatioChange` (page DPR changed — display move or
 * Electron webFrame.setZoomLevel / VS Code Cmd++) and
 * `handleCharSizeChanged` (measured font cell size changed — font /
 * lineHeight / letterSpacing edits) invalidate the cached glyph atlas
 * AND the current `IRenderMetrics` (cellW/cellH/baseline/descent are
 * now wrong).
 *
 * Previous implementations of both handlers in WebgpuRenderer just
 * resized the canvas at the OLD metrics and requested a redraw. That
 * left the atlas cached at the old DPR while the cell grid was laid
 * out at the new one — visible symptom: small glyphs spread across
 * normal-sized cells (huge apparent letter-spacing). Reproduced by
 * Cmd++ in VS Code on the WebGPU renderer.
 *
 * The fix: both handlers MUST trigger a full font refresh (rebuild
 * atlas + push fresh metrics) before any further draw. The renderer
 * delegates to the helpers here; the addon binds the callback to its
 * `_refreshFont` (which calls `SharedDevice.updateFontConfig` +
 * `renderer.setMetrics`).
 *
 * Modeled as a callback rather than a callback-and-direct-state-mutate
 * so the helpers stay pure-testable: WebgpuRenderer itself is
 * GPU-dependent and not unit-testable, so we pin the contract here.
 */
export interface IFontResyncTarget {
  /**
   * Rebuild the glyph atlas with fresh font config and push new
   * `IRenderMetrics`. Must run synchronously; if it can fail it must
   * throw rather than silently no-op.
   */
  refreshFont(): void;
}

export function onDevicePixelRatioChanged(target: IFontResyncTarget): void {
  target.refreshFont();
}

export function onCharSizeChanged(target: IFontResyncTarget): void {
  target.refreshFont();
}
