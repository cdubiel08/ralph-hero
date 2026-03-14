import type { Scene } from "./schema";

const DEFAULT_DURATIONS: Record<Scene["type"], number> = {
  title: 3.5,
  feature: 4.5,
  screenshot: 6.5,
  "before-after": 6,
  bullets: 5,
  flow: 7,
  outro: 3.5,
};

export function sceneDurationFrames(scene: Scene, fps: number): number {
  const seconds = scene.durationSeconds ?? DEFAULT_DURATIONS[scene.type];
  return Math.round(seconds * fps);
}

export function calculateTotalDuration(scenes: Scene[], fps: number): number {
  return scenes.reduce((total, scene) => total + sceneDurationFrames(scene, fps), 0);
}
