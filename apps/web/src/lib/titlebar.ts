import { getDesktopBridge } from "../bridge.ts";

/** Left inset that keeps the bar's first control clear of the macOS traffic lights. */
export const TRAFFIC_LIGHT_INSET = 80;

/**
 * True when the page's top bar is the window's title bar: the macOS desktop
 * app hides the native one. A plain browser, or another platform, keeps a
 * normal bar.
 */
export const insetTitleBar = (): boolean => getDesktopBridge()?.titleBar === "inset";
