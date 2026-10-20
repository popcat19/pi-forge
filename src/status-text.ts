import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type StatusColor = Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0];

/** Presentation-only fallback; never wraps status delivery or runtime state changes. */
export function formatStatusText(ctx: Pick<ExtensionContext, "ui">, color: StatusColor, text: string): string {
	try {
		return ctx.ui.theme?.fg(color, text) ?? text;
	} catch {
		// Custom hosts may omit theme; uninitialized SDK theme proxies can throw.
		return text;
	}
}
