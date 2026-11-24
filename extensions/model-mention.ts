/**
 * Model Mention Extension
 *
 * Type `#` in the editor to get an autocomplete list of agent models, like
 * `@` for files. Selecting an entry replaces the `#query` token with the
 * model reference (`provider/id`) in the input field.
 *
 * The list mirrors pi's built-in model selector: scoped models when
 * `--models`/`enabledModels` scoping is configured, otherwise every model
 * whose provider has working credentials.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  fuzzyFilter,
} from "@earendil-works/pi-tui";

/** `#query` at the start of the input or after whitespace. */
function extractModelToken(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/)?.[1];
}

function formatModelItem(
  model: Model<any>,
  currentRef: string | undefined,
): AutocompleteItem {
  const ref = `${model.provider}/${model.id}`;
  return {
    value: ref,
    label: ref,
    description: ref === currentRef ? `${model.name} (current)` : model.name,
  };
}

function createModelAutocompleteProvider(
  current: AutocompleteProvider,
  getModels: () => readonly Model<any>[],
  getCurrentRef: () => string | undefined,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const token = extractModelToken(line.slice(0, cursorCol));
      if (token === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const models = getModels();
      if (options.signal.aborted || models.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const currentRef = getCurrentRef();
      const items = fuzzyFilter(
        [...models],
        token,
        (m) => `${m.provider}/${m.id} ${m.name}`,
      ).map((m) => formatModelItem(m, currentRef));
      if (items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { items, prefix: `#${token}` };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      if (extractModelToken(line.slice(0, cursorCol)) !== undefined) {
        return false;
      }
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    // Scoped models are resolved at session start; an empty list means no
    // scoping is configured, so fall back to the full available catalogue.
    const scoped = ctx.scopedModels.map((entry) => entry.model);

    const getModels = (): readonly Model<any>[] =>
      scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();

    const getCurrentRef = (): string | undefined =>
      ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

    ctx.ui.addAutocompleteProvider((current) =>
      createModelAutocompleteProvider(current, getModels, getCurrentRef),
    );
  });
}
