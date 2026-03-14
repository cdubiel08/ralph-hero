export interface ExportPreset {
  name: string;
  width: number;
  height: number;
  fps: number;
}

export const presets: Record<string, ExportPreset> = {
  "sprint-demo": { name: "sprint-demo", width: 1920, height: 1080, fps: 30 },
  "social-square": { name: "social-square", width: 1080, height: 1080, fps: 30 },
  "social-reel": { name: "social-reel", width: 1080, height: 1920, fps: 30 },
  presentation: { name: "presentation", width: 1920, height: 1080, fps: 30 },
};

export function resolvePreset(format: string): ExportPreset {
  const formatToPreset: Record<string, string> = {
    "16:9": "sprint-demo",
    "1:1": "social-square",
    "9:16": "social-reel",
  };
  const presetName = formatToPreset[format] ?? "sprint-demo";
  return presets[presetName];
}
