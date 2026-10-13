import { Container, Markdown, Text } from "@mariozechner/pi-tui";

export function getText(): new (text: string, paddingX: number, paddingY: number) => any {
	return Text;
}

export function getContainer(): new (...args: any[]) => any {
	return Container;
}

export function getMarkdown(): new (...args: any[]) => any {
	return Markdown;
}
