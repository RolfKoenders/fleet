/** Why something was not done, as the page answers it (`status`, `code`) and the command words it (`message`). */
export type Refusal = { status: number; code: string; message: string; extra?: Record<string, unknown> };
