/**
 * describe-image — let a text-only model read images through a vision model.
 *
 * Problem: chat models without image input cannot see image files, so the
 * built-in `read` tool gives them nothing. This extension gives them eyes:
 * the `describe_image` tool takes an image path plus an optional question,
 * sends the image to a vision-capable chat model, and returns that model's
 * answer as the tool result so the calling model can reason about the
 * image's contents (screenshots, photos, diagrams, charts).
 *
 * Which vision model answers is configurable, resolved in this order:
 *
 *   1. `PI_DESCRIBE_IMAGE_MODEL` environment variable
 *   2. `describeImageModel` in settings.json (project `.pi/settings.json`
 *      overrides `~/.pi/agent/settings.json`)
 *   3. `"auto"` (default): the session model if it accepts images, else the
 *      first available model whose input modalities include `"image"`
 *
 * Both 1 and 2 use the `"provider/modelId"` form, e.g.
 * `"openrouter/anthropic/claude-haiku-4.5"`. The value `"auto"` forces the
 * automatic pick.
 *
 * When the session model already accepts image input, the tool hides its own
 * declaration (`prepareLoadout` + `hiddenDeclarations`): a vision-capable
 * model is not advertised a tool that would just delegate back to itself.
 * The tool stays registered, active, and callable by other tools.
 *
 * `/describe-image` reports which model is resolved
 *
 * The nested model call's `usage` is included in the tool result so session
 * token totals stay accurate.
 *
 * Place in ~/.pi/agent/extensions/ for global access, or .pi/extensions/ for
 * project-local.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import type { Api, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TOOL_NAME = "describe_image";
const SETTING_KEY = "describeImageModel";
const ENV_VAR = "PI_DESCRIBE_IMAGE_MODEL";

/** Refuse to base64 absurdly large "images". */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const VISION_SYSTEM_PROMPT = [
  "You are a precise vision assistant embedded in a coding agent.",
  "Describe the image you are shown faithfully and completely.",
  "Transcribe any visible text verbatim.",
  "For screenshots and UI, name the app or website and describe the visible elements and their state.",
  "For charts and diagrams, summarize the data or structure precisely.",
  "Report only what is visible; say so when something is unclear or cut off.",
  "Never speculate beyond the image.",
].join(" ");

const DEFAULT_QUESTION =
  "Describe this image in detail, including any visible text verbatim.";

const parameters = Type.Object({
  path: Type.String({
    description:
      "Path to the image file (jpg, png, gif, webp, or bmp). Absolute, or relative to the working directory.",
  }),
  question: Type.Optional(
    Type.String({
      description:
        'Optional question for the vision model, e.g. "What does this error dialog say?". Omit for a full description.',
    }),
  ),
});

interface DescribeDetails {
  path: string;
  mimeType: string;
  model: string | null;
  modelSource: string;
  question: string;
}

/** Either a resolved vision model, or why none could be resolved. */
type Resolved =
  { model: Model<Api>; source: string } | { source: string; reason: string };

function acceptsImages(model: Model<Api>): boolean {
  return model.input.includes("image");
}

function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Sniff the mime type of a supported image format from magic bytes.
 * Covers the formats the vision models accept: png, jpeg, gif, webp, bmp.
 * (Inline so the extension has no npm dependencies — extensions loaded from
 * `~/.pi/agent/extensions/` cannot resolve the repo's `node_modules`.)
 */
function sniffImageMime(buf: Buffer): string | null {
  const eq = (offset: number, ...bytes: number[]): boolean =>
    bytes.every((v, i) => buf[offset + i] === v);
  if (eq(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (
    eq(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
    eq(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
  ) {
    return "image/gif"; // GIF87a / GIF89a
  }
  if (eq(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (eq(0, 0x42, 0x4d)) return "image/bmp";
  if (eq(0, 0x52, 0x49, 0x46, 0x46) && eq(8, 0x57, 0x45, 0x42, 0x50)) {
    return "image/webp"; // RIFF....WEBP
  }
  return null;
}

/**
 * Read the configured model string: env var first, then settings.json with
 * project (`.pi/settings.json`) overriding global (`~/.pi/agent/settings.json`),
 * matching the delegate extension's setting convention.
 */
function readConfiguredModel(): string | undefined {
  if (process.env[ENV_VAR] && process.env[ENV_VAR].length > 0) {
    return process.env[ENV_VAR];
  }

  const paths = [
    join(process.cwd(), ".pi", "settings.json"),
    join(homedir(), ".pi", "agent", "settings.json"),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
      const value = parsed[SETTING_KEY];
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Skip unreadable or unparseable settings files.
    }
  }
  return undefined;
}

/**
 * Resolve which vision model should answer: env var, settings, or the
 * automatic fallback (session model, then first available vision model).
 */
function resolveVisionModel(ctx: ExtensionContext): Resolved {
  const configured = readConfiguredModel();

  if (configured && configured !== "auto") {
    const slash = configured.indexOf("/");
    if (slash === -1) {
      return {
        source: `${SETTING_KEY}/${ENV_VAR} "${configured}"`,
        reason: 'value is not in "provider/modelId" format',
      };
    }
    const found = ctx.modelRegistry.find(
      configured.slice(0, slash),
      configured.slice(slash + 1),
    );
    if (!found) {
      return {
        source: `${SETTING_KEY}/${ENV_VAR} "${configured}"`,
        reason: "value matched no known model",
      };
    }
    if (!acceptsImages(found)) {
      return {
        source: `${SETTING_KEY}/${ENV_VAR} "${configured}"`,
        reason: "the configured model does not accept image input",
      };
    }
    return { model: found, source: `configured: "${configured}"` };
  }

  // "auto": prefer the session model when it can already see images.
  if (ctx.model && acceptsImages(ctx.model)) {
    return { model: ctx.model, source: "auto: session model (vision-capable)" };
  }
  const available = ctx.modelRegistry.getAvailable().filter(acceptsImages);
  if (available.length > 0) {
    return {
      model: available[0],
      source: `auto: first available vision model (${available.length} found)`,
    };
  }
  const known = ctx.modelRegistry.getAll().filter(acceptsImages);
  if (known.length > 0) {
    return {
      model: known[0],
      source: `auto: first known vision model (${known.length} found)`,
    };
  }
  return {
    source: "auto",
    reason: "no known model accepts image input — configure a vision model",
  };
}

export default function describeImageExtension(pi: ExtensionAPI): void {
  // Latest session model, from session_start / model_select. prepareLoadout
  // uses it to hide the tool from models that already see images.
  let sessionModel: Model<Api> | undefined;
  pi.on("session_start", (_event, ctx) => {
    sessionModel = ctx.model;
  });
  pi.on("model_select", (event) => {
    sessionModel = event.model;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Describe image",
    description:
      'Ask a vision-capable model to describe an image file. Use this to read any image you cannot view directly — screenshots, photos, diagrams, charts. Pass `question` to focus the answer (e.g. "what error is shown"), or omit it for a full description. Returns the vision model\'s answer as text.',
    promptSnippet: "ask a vision model to describe an image file",
    prepareLoadout: () =>
      sessionModel && acceptsImages(sessionModel)
        ? { hiddenDeclarations: [TOOL_NAME] }
        : undefined,
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const absPath = isAbsolute(params.path)
        ? params.path
        : resolve(ctx.cwd, params.path);

      let buf: Buffer;
      try {
        buf = await readFile(absPath);
      } catch (err) {
        throw new Error(
          `cannot read image: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (buf.byteLength === 0)
        throw new Error(`image file is empty: ${absPath}`);
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(
          `image file is ${Math.round(buf.byteLength / 1024 / 1024)} MB; refuse to load over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
        );
      }

      const mimeType = sniffImageMime(buf);
      if (!mimeType) {
        throw new Error(
          `not a recognized image file (png, jpg, gif, webp, bmp): ${absPath}`,
        );
      }

      const picked = resolveVisionModel(ctx);
      const question = params.question?.trim()
        ? params.question
        : DEFAULT_QUESTION;
      const details: DescribeDetails = {
        path: absPath,
        mimeType,
        model: "model" in picked ? modelRef(picked.model) : null,
        modelSource: picked.source,
        question,
      };

      if (!("model" in picked)) {
        return {
          content: [
            {
              type: "text",
              text: [
                `No vision model available for describe_image (${picked.source}: ${picked.reason}).`,
                `Set "${SETTING_KEY}": "provider/modelId" in settings.json, or export ${ENV_VAR}.`,
              ].join("\n"),
            },
          ],
          details,
          isError: true,
        };
      }

      const message: UserMessage = {
        role: "user",
        content: [
          { type: "image", data: buf.toString("base64"), mimeType },
          { type: "text", text: question },
        ],
        timestamp: Date.now(),
      };
      const requestContext: Context = {
        systemPrompt: VISION_SYSTEM_PROMPT,
        messages: [message],
      };

      const response = await ctx.modelRegistry.complete(
        picked.model,
        requestContext,
        {
          signal,
        },
      );

      if (response.stopReason !== "stop") {
        return {
          content: [
            {
              type: "text",
              text: `Vision model call did not complete (stopReason: ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}).`,
            },
          ],
          details,
          usage: response.usage,
          isError: true,
        };
      }

      const description = response.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();

      if (!description) {
        return {
          content: [{ type: "text", text: "Vision model returned no text." }],
          details,
          usage: response.usage,
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `[described by ${modelRef(picked.model)}]\n${description}`,
          },
        ],
        details,
        usage: response.usage,
      };
    },
  });

  pi.registerCommand("describe-image", {
    description: "Show which vision model the describe_image tool uses",
    handler: async (_args, ctx) => {
      const picked = resolveVisionModel(ctx);

      const lines: string[] = [];
      if ("model" in picked) {
        lines.push(
          `describe_image vision model: ${modelRef(picked.model)} (${picked.model.name})`,
        );
        lines.push(`resolved from: ${picked.source}`);
      } else {
        lines.push(
          `describe_image has no vision model — ${picked.reason} (${picked.source})`,
        );
      }
      lines.push(
        `Configure: "${SETTING_KEY}": "provider/modelId" in settings.json, or the ${ENV_VAR} env var ("auto" for the default pick).`,
      );

      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
