// Label pills and bars. Ground colours come from the resolved frame
// state, so contrast is computed on what is drawn, never on a token alone.
import { contrastRatio } from "../shared/color.mjs";

// Padding on the 1280 grid, from the Harris skill: 8 px vertical,
// 4 px horizontal, 6 px gap. At 1080p (tokenScale 1.5) that is 12/6/9.
export const PILL_PADDING = { vertical1280: 8, horizontal1280: 4, gap1280: 6, scale: 1.5 };
export const PILL_FILL = "#14213D";
export const PILL_TEXT = "#FFFFFF";

export function pillPadding() {
  const s = PILL_PADDING.scale;
  return { vertical: PILL_PADDING.vertical1280 * s, horizontal: PILL_PADDING.horizontal1280 * s, gap: PILL_PADDING.gap1280 * s };
}

/** True when white text on this ground clears the 7:1 floor. */
export function pillPasses(ground = PILL_FILL) {
  return contrastRatio(PILL_TEXT, ground) >= 7;
}

/** Measured ratio for the lint output. */
export function pillRatio(ground = PILL_FILL) {
  return contrastRatio(PILL_TEXT, ground);
}
