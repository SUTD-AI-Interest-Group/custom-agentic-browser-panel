/** Fixed visual question only. Never tool names, arguments, or chat instructions. */
export const MIRAGE_SCREEN_FORM = {
  screen_type: { enum: ['dialog', 'form', 'document', 'other'] },
} as const
