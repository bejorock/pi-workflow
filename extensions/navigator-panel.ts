import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Shared visual shell for the run and saved-workflow navigators. */
export function renderNavigatorPanel(title: string, lines: string[], width: number, theme: Theme, focused: boolean): string[] {
	const innerWidth = Math.max(1, width - 4);
	const border = (s: string) => theme.fg(focused ? "accent" : "borderMuted", s);
	const label = ` ${title} `;
	const heading = focused ? theme.fg("dim", theme.bold(label)) : theme.fg("muted", label);
	const background = (s: string) => theme.bg("customMessageBg", s) ?? s;
	return [background(border("╭─") + heading + border("─".repeat(Math.max(0, innerWidth + 1 - visibleWidth(label))) + "╮")),
		...lines.map(line => {
			const full = border("│ ") + truncateToWidth(line, innerWidth, "", true) + border(" │");
			return background(full + " ".repeat(Math.max(0, width - visibleWidth(full))));
		}), background(border(`╰${"─".repeat(innerWidth + 2)}╯`))];
}
