/**
 * Animation presets for promotion popups. GET /promotions/animations serves
 * this catalogue, so the customer app and the admin console build their lists
 * from it instead of hard-coding names.
 *
 * The backend only names a preset; the app draws it. A promotion's theme can
 * combine three kinds:
 *   entrance  how the popup appears (fade, slide, ...)
 *   effect    something played over it (confetti, snow, ...)
 *   loop      continuous motion while it is open (float3d, pulse, ...)
 * For artwork beyond the presets, an admin uploads a Lottie file instead
 * (see lottie.ts).
 *
 * Apps released before Nov 2026 only read `theme.animation` and only know the
 * six LEGACY presets, so the server always fills `animation` with one of them
 * (see legacyAnimation below).
 */

export type AnimationKind = 'entrance' | 'effect' | 'loop';

export interface AnimationPreset {
  key: string;
  label: string;
  kind: AnimationKind;
  /** Played instead by an app that doesn't know this preset (null = none needed). */
  fallback: string | null;
  /** Expensive to draw: skip on low-end phones and when reduce motion is on. */
  heavy: boolean;
  /** Known to every app version (allowed in the old `theme.animation` field). */
  legacy: boolean;
  /** Date the preset was added, so the app can tell which ones it predates. */
  since: string;
}

export const ANIMATION_PRESETS: readonly AnimationPreset[] = [
  { key: 'fade', label: 'Fade in', kind: 'entrance', fallback: null, heavy: false, legacy: true, since: '2026-11-10' },
  { key: 'slide', label: 'Slide in', kind: 'entrance', fallback: 'fade', heavy: false, legacy: true, since: '2026-11-10' },
  { key: 'bounce', label: 'Bounce in', kind: 'entrance', fallback: 'fade', heavy: false, legacy: true, since: '2026-11-10' },
  { key: 'zoom', label: 'Zoom in', kind: 'entrance', fallback: 'fade', heavy: false, legacy: false, since: '2026-11-20' },
  { key: 'confetti', label: 'Confetti burst', kind: 'effect', fallback: null, heavy: true, legacy: true, since: '2026-11-10' },
  { key: 'snow', label: 'Falling snow', kind: 'effect', fallback: 'confetti', heavy: true, legacy: false, since: '2026-11-20' },
  { key: 'sparkle', label: 'Sparkles', kind: 'effect', fallback: 'confetti', heavy: false, legacy: false, since: '2026-11-20' },
  { key: 'float3d', label: '3D float', kind: 'loop', fallback: null, heavy: true, legacy: true, since: '2026-11-10' },
  { key: 'pulse', label: 'Pulse (flash sale)', kind: 'loop', fallback: 'bounce', heavy: false, legacy: false, since: '2026-11-20' },
  { key: 'shine', label: 'Shine sweep', kind: 'loop', fallback: 'fade', heavy: false, legacy: false, since: '2026-11-20' },
];

/** "No animation". Valid wherever a preset is. */
export const NO_ANIMATION = 'none';

export const presetKeys = (kind: AnimationKind) =>
  ANIMATION_PRESETS.filter((p) => p.kind === kind).map((p) => p.key);

/** Values the old `theme.animation` field accepts: the six presets every app knows. */
export const LEGACY_ANIMATIONS = [NO_ANIMATION, ...ANIMATION_PRESETS.filter((p) => p.legacy).map((p) => p.key)];

// Limits for the settings of each part (the DTO enforces them; the catalogue
// shows them so the admin form can use the same ranges).
export const ANIMATION_LIMITS = {
  entrance: { durationMs: { min: 100, max: 3000, default: 400 }, delayMs: { min: 0, max: 5000, default: 0 } },
  effect: { durationMs: { min: 500, max: 10000, default: 3000 }, maxColors: 6 },
  lottie: { speed: { min: 0.25, max: 3, default: 1 } },
} as const;
export const SLIDE_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export const LOOP_INTENSITIES = ['low', 'medium', 'high'] as const;
export const LOTTIE_PLACEMENTS = ['hero', 'background', 'overlay'] as const;

const byKey = new Map(ANIMATION_PRESETS.map((p) => [p.key, p]));

/** Follows fallbacks until it reaches a preset every app knows (or 'none'). */
export function toLegacy(key: string | undefined | null): string {
  let current = key ?? NO_ANIMATION;
  for (let i = 0; i < ANIMATION_PRESETS.length + 1; i++) {
    if (current === NO_ANIMATION) return current;
    const preset = byKey.get(current);
    if (!preset) return 'fade';
    if (preset.legacy) return current;
    current = preset.fallback ?? 'fade';
  }
  return 'fade';
}

interface ThemeParts {
  animation?: string;
  entrance?: { preset: string } | null;
  effect?: { preset: string } | null;
  loop?: { preset: string } | null;
}

/**
 * The value for `theme.animation`, read by older apps. Kept when the admin
 * set it. Otherwise it comes from the new parts, choosing the most visible one
 * (effect, then loop, then entrance), mapped to a preset older apps know.
 */
export function legacyAnimation(theme: ThemeParts): string | undefined {
  if (theme.animation) return theme.animation;
  const chosen = [theme.effect, theme.loop, theme.entrance].find((p) => p && p.preset !== NO_ANIMATION);
  if (chosen) return toLegacy(chosen.preset);
  if (theme.entrance || theme.effect || theme.loop) return NO_ANIMATION;
  return undefined;
}

/** What GET /promotions/animations returns. */
export function animationCatalogue() {
  return {
    version: '2026-11-20',
    presets: ANIMATION_PRESETS,
    none: NO_ANIMATION,
    legacyAnimations: LEGACY_ANIMATIONS,
    limits: ANIMATION_LIMITS,
    slideDirections: SLIDE_DIRECTIONS,
    loopIntensities: LOOP_INTENSITIES,
    lottiePlacements: LOTTIE_PLACEMENTS,
    rules: {
      unknownPreset: 'Play its `fallback` (follow the chain); if it has none, or the preset is not in this list at all, play "fade".',
      reduceMotion: 'When the phone has reduce motion on: entrance "fade", no effect, no loop, and show the Lottie first frame only.',
      lowEndDevice: 'Skip presets with heavy: true (and Lottie overlays) on low-end phones.',
      lottie: 'When the promotion has lottieUrl, play it with the theme.lottie settings. If it fails to load, use the presets.',
      olderApps: 'Apps that only read theme.animation get one of legacyAnimations, filled in by the server.',
    },
  };
}
