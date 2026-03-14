import { z } from "zod";

const TitleSceneSchema = z.object({
  type: z.literal("title"),
  headline: z.string(),
  subtitle: z.string().optional(),
  logo: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

const FeatureSceneSchema = z.object({
  type: z.literal("feature"),
  name: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  illustration: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

const ScreenshotSceneSchema = z.object({
  type: z.literal("screenshot"),
  src: z.string(),
  highlights: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        label: z.string().optional(),
      })
    )
    .optional(),
  caption: z.string().optional(),
  zoom: z.number().optional(),
  durationSeconds: z.number().positive().optional(),
});

const BeforeAfterSceneSchema = z.object({
  type: z.literal("before-after"),
  before: z.string(),
  after: z.string(),
  caption: z.string().optional(),
  transition: z.enum(["wipe", "slide", "fade"]).optional(),
  durationSeconds: z.number().positive().optional(),
});

const BulletsSceneSchema = z.object({
  type: z.literal("bullets"),
  title: z.string(),
  items: z.array(z.string()).min(1),
  icon: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

const FlowSceneSchema = z.object({
  type: z.literal("flow"),
  steps: z.array(z.string()).min(2),
  direction: z.enum(["horizontal", "vertical"]).optional(),
  caption: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

const OutroSceneSchema = z.object({
  type: z.literal("outro"),
  text: z.string(),
  cta: z.string().optional(),
  links: z.array(z.string()).optional(),
  durationSeconds: z.number().positive().optional(),
});

export const SceneSchema = z.discriminatedUnion("type", [
  TitleSceneSchema,
  FeatureSceneSchema,
  ScreenshotSceneSchema,
  BeforeAfterSceneSchema,
  BulletsSceneSchema,
  FlowSceneSchema,
  OutroSceneSchema,
]);

export type Scene = z.infer<typeof SceneSchema>;

export const VideoInputSchema = z.object({
  sprint: z.number().int().positive().optional(),
  date: z.string(),
  team: z.string(),
  theme: z.string().default("energetic"),
  format: z.enum(["16:9", "1:1", "9:16"]).default("16:9"),
  scenes: z.array(SceneSchema).min(1),
});

export type VideoInput = z.infer<typeof VideoInputSchema>;
