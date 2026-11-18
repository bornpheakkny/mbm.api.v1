import { z } from 'zod';

/**
 * Per-user display preferences (stored as JSON on the user).
 * - barColor: usage bars use each category's color, or budget status colors (teal / amber / red)
 * - badgeStyle: how category badges look
 */
export const PreferencesSchema = z.object({
  barColor: z.enum(['category', 'status']),
  badgeStyle: z.enum(['soft', 'solid', 'outline']),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = { barColor: 'category', badgeStyle: 'soft' };

/** Partial update sent by the client */
export const PreferencesPatchSchema = PreferencesSchema.partial();

/** Fill in defaults and drop anything unknown or invalid */
export function normalizePreferences(raw: unknown): Preferences {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const parsed = PreferencesPatchSchema.safeParse(obj);
  return { ...DEFAULT_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}

/** Preset color names (see the app's CATEGORY_COLORS) or any #rrggbb hex color */
export const PRESET_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'magenta'] as const;

export const ColorSchema = z
  .string()
  .trim()
  .refine((v) => (PRESET_COLORS as readonly string[]).includes(v) || /^#[0-9a-fA-F]{6}$/.test(v), {
    message: 'Use a preset color or a hex color like #1a2b3c',
  })
  .transform((v) => (v.startsWith('#') ? v.toLowerCase() : v));
