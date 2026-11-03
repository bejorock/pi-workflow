/** Claude-compatible header cap; other character caps are pi-workflow policy.
 * Reject rather than truncate: option labels/defaults are routing values.
 */
export const QUESTION_LIMITS = Object.freeze({ question: 240, header: 12, label: 60, description: 160 });
export const characterCount = (text: string): number => Array.from(text).length;
export const questionHeader = (text: string): string => Array.from(text).slice(0, QUESTION_LIMITS.header).join("");
export interface BoundedQuestion {
	question: string; header: string;
	options?: { label: string; description?: string }[];
}
export function questionLengthError(questions: readonly BoundedQuestion[]): string | undefined {
	for (const [i, q] of questions.entries()) {
		for (const field of ["question", "header"] as const) {
			if (characterCount(q[field]) > QUESTION_LIMITS[field]) {
				return `Question ${i + 1} ${field} exceeds ${QUESTION_LIMITS[field]} characters. Shorten it; put long context in a preview or plan/contract.`;
			}
		}
		for (const [j, option] of (q.options ?? []).entries()) {
			for (const field of ["label", "description"] as const) {
				if (option[field] !== undefined && characterCount(option[field]) > QUESTION_LIMITS[field]) {
					return `Question ${i + 1} option ${j + 1} ${field} exceeds ${QUESTION_LIMITS[field]} characters. Use a concise label (ideally 1–5 words), short description, and a preview for details.`;
				}
			}
		}
	}
	return undefined;
}
