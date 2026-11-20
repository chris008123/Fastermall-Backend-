import { BadRequestException } from '@nestjs/common';

/**
 * Checks an uploaded Lottie animation (the JSON exported from After Effects
 * with Bodymovin, or downloaded from LottieFiles) before it is stored.
 *
 * Refused:
 * - anything that isn't a Lottie JSON object (including .lottie zip files);
 * - silly sizes or lengths (the popup must stay quick to load and play);
 * - images loaded from outside the file: every asset must be embedded, so
 *   the animation never fetches anything from other servers;
 * - After Effects expressions: the web player (used by the admin console
 *   preview) runs them as JavaScript.
 *
 * What is stored is the re-serialised, minified JSON, never the raw upload.
 */

export const LOTTIE_LIMITS = {
  maxDimension: 4096,
  maxFrameRate: 120,
  maxDurationSeconds: 30,
  maxLayers: 1000,
  maxNodes: 500_000,
  maxDepth: 200,
} as const;

export interface LottieInfo {
  width: number;
  height: number;
  frameRate: number;
  durationMs: number;
  bytes: number;
}

const EMBEDDED_IMAGE = /^data:image\/(png|jpe?g|webp);base64,/i;

function refuse(code: string, message: string): never {
  throw new BadRequestException({ message, code });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates and minifies a Lottie file. Returns the bytes to store and its basic facts. */
export function checkLottie(buffer: Buffer): { json: Buffer; info: LottieInfo } {
  // A .lottie file is a zip ("PK" header).
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    refuse('LOTTIE_ZIP_NOT_SUPPORTED', 'Upload the Lottie JSON file, not a .lottie file. Export it as JSON from LottieFiles.');
  }

  let data: any;
  try {
    data = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch {
    refuse('INVALID_LOTTIE', 'The file is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    refuse('INVALID_LOTTIE', 'The file is not a Lottie animation');
  }

  const { v, fr, ip, op, w, h, layers, assets } = data;
  if (typeof v !== 'string' || !isNum(fr) || !isNum(ip) || !isNum(op) || !isNum(w) || !isNum(h) || !Array.isArray(layers)) {
    refuse('INVALID_LOTTIE', 'The file is not a Lottie animation (it needs v, fr, ip, op, w, h and layers)');
  }
  if (w < 1 || h < 1 || w > LOTTIE_LIMITS.maxDimension || h > LOTTIE_LIMITS.maxDimension) {
    refuse('LOTTIE_TOO_LARGE', `The animation must be at most ${LOTTIE_LIMITS.maxDimension} × ${LOTTIE_LIMITS.maxDimension}`);
  }
  if (fr <= 0 || fr > LOTTIE_LIMITS.maxFrameRate) {
    refuse('INVALID_LOTTIE', `The frame rate must be between 1 and ${LOTTIE_LIMITS.maxFrameRate}`);
  }
  if (op <= ip) refuse('INVALID_LOTTIE', 'The animation has no frames');
  const seconds = (op - ip) / fr;
  if (seconds > LOTTIE_LIMITS.maxDurationSeconds) {
    refuse('LOTTIE_TOO_LONG', `The animation must be at most ${LOTTIE_LIMITS.maxDurationSeconds} seconds long`);
  }
  if (layers.length === 0) refuse('INVALID_LOTTIE', 'The animation has no layers');
  if (layers.length > LOTTIE_LIMITS.maxLayers) {
    refuse('LOTTIE_TOO_COMPLEX', `The animation must have at most ${LOTTIE_LIMITS.maxLayers} layers`);
  }

  if (assets !== undefined) {
    if (!Array.isArray(assets)) refuse('INVALID_LOTTIE', 'assets must be a list');
    for (const asset of assets) {
      if (!asset || typeof asset !== 'object') refuse('INVALID_LOTTIE', 'An asset is not valid');
      // Image assets have a path `p`; precompositions have `layers` instead.
      if (asset.p !== undefined) {
        if (asset.e !== 1 || typeof asset.p !== 'string' || !EMBEDDED_IMAGE.test(asset.p)) {
          refuse(
            'LOTTIE_EXTERNAL_ASSETS',
            'Every image in the animation must be embedded (PNG, JPEG or WebP). Export with "Glyphs / images embedded" turned on.',
          );
        }
      }
    }
  }

  walk(data);

  const json = Buffer.from(JSON.stringify(data), 'utf8');
  return {
    json,
    info: { width: w, height: h, frameRate: fr, durationMs: Math.round(seconds * 1000), bytes: json.length },
  };
}

// One pass over the whole tree: bounds its size and depth, and finds
// expressions (a string `x` on an animated property).
function walk(root: unknown) {
  let nodes = 0;
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++nodes > LOTTIE_LIMITS.maxNodes) refuse('LOTTIE_TOO_COMPLEX', 'The animation is too complex');
    if (depth > LOTTIE_LIMITS.maxDepth) refuse('LOTTIE_TOO_COMPLEX', 'The animation is nested too deeply');
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === 'object') stack.push([item, depth + 1]);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'x' && typeof value === 'string') {
          refuse('LOTTIE_EXPRESSIONS', 'The animation uses After Effects expressions, which are not allowed. Bake them into keyframes before exporting.');
        }
        if (value && typeof value === 'object') stack.push([value, depth + 1]);
      }
    }
  }
}
