/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn and persists them in the session.
 * Survives pi exit + resume — checkpoints are restored from session history.
 * Supports both undo and redo via /tree navigation, /undo, and /redo commands.
 *
 * Workflow:
 *   1. Work with the agent normally — checkpoints are saved before each turn
 *   2. If something goes wrong: /undo (or Escape Escape → /tree → navigate back)
 *   3. If you went too far back: /redo (or /tree → navigate forward)
 *   4. Extension offers to restore code to match the conversation point
 *
 * Uses `git stash create` (no stash reflog entries, no stash list pollution).
 * Orphaned stash commit objects are eventually cleaned up by git gc.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "git-checkpoint";

interface CheckpointData {
  entryId: string;
  stashRef: string;
  timestamp: number;
}

/**
 * A user message entry on the active branch.
 */
interface UserMessageNode {
  entryId: string;
  /** Short preview of the user's message text */
  preview: string;
}

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, string>();
  let currentUserEntryId: string | undefined;

  /**
   * Redo stack: stores leaf IDs pushed by /undo so /redo can navigate back.
   * Cleared on any new user prompt (agent_start) since new work invalidates redo.
   */
  const redoStack: string[] = [];

  /**
   * Flag to suppress the session_tree event handler's code restore prompt.
   * Set to true before navigateTree calls from /undo and /redo,
   * since those commands handle code restore themselves.
   */
  let skipTreeCodeRestore = false;

  /**
   * Reconstruct checkpoints from session history.
   * Scans custom entries on the current branch for our checkpoint records.
   */
  const reconstructCheckpoints = (ctx: ExtensionContext) => {
    checkpoints.clear();
    currentUserEntryId = undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        const data = entry.data as CheckpointData;
        if (data.stashRef && data.entryId) {
          checkpoints.set(data.entryId, data.stashRef);
        }
      }
    }
  };

  // Restore checkpoints when session loads or tree navigates
  pi.on("session_start", async (_event, ctx) => reconstructCheckpoints(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructCheckpoints(ctx));

  // Track which user entry we're currently responding to
  pi.on("tool_result", async (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf) currentUserEntryId = leaf.id;
  });

  // Invalidate redo stack when new agent work starts
  pi.on("agent_start", async () => {
    redoStack.length = 0;
  });

  // Create a checkpoint before each agent turn
  pi.on("turn_start", async () => {
    // Nothing to checkpoint if we don't know which user message we're responding to
    if (!currentUserEntryId) return;

    // git stash create returns a commit SHA if there are dirty files,
    // or empty string if the working tree is clean
    const { stdout, code } = await pi.exec("git", ["stash", "create"]);
    if (code !== 0) {
      // Not a git repo or git error — skip silently
      return;
    }

    const stashRef = stdout.trim();
    if (!stashRef) {
      // Clean working tree — nothing to checkpoint
      return;
    }

    // Store in memory
    checkpoints.set(currentUserEntryId, stashRef);

    // Persist to session so it survives restarts
    pi.appendEntry(CUSTOM_TYPE, {
      entryId: currentUserEntryId,
      stashRef,
      timestamp: Date.now(),
    } satisfies CheckpointData);
  });

  /**
   * Verify a stash ref still exists in the git object database.
   * Stash objects can be garbage-collected after gc.pruneExpire (default 2 weeks).
   */
  const refExists = async (ref: string): Promise<boolean> => {
    const { code } = await pi.exec("git", ["cat-file", "-t", ref]);
    return code === 0;
  };

  /**
   * Extract a short preview from user message content.
   */
  const getUserMessagePreview = (entry: {
    message: { role: string; content: string | unknown[] };
  }): string => {
    const content = entry.message.content;
    if (typeof content === "string") {
      return content.slice(0, 60) + (content.length > 60 ? "…" : "");
    }
    // Content is array of blocks — find the first text block
    const textBlock = (content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text" && b.text,
    );
    if (textBlock?.text) {
      return (
        textBlock.text.slice(0, 60) + (textBlock.text.length > 60 ? "…" : "")
      );
    }
    return "(image or non-text message)";
  };

  /**
   * Get all user messages on the current branch, ordered from root to leaf.
   */
  const getUserMessages = (ctx: ExtensionContext): UserMessageNode[] => {
    const branch = ctx.sessionManager.getBranch();
    const userMessages: UserMessageNode[] = [];

    for (const entry of branch) {
      if (entry.type === "message" && (entry as any).message?.role === "user") {
        userMessages.push({
          entryId: entry.id,
          preview: getUserMessagePreview(entry as any),
        });
      }
    }

    return userMessages;
  };

  /**
   * Find the checkpoint nearest to a given entry ID on the branch.
   * Walks backward from the target to find the closest entry with a checkpoint.
   */
  const findCheckpointForEntry = (
    ctx: ExtensionContext,
    targetEntryId: string,
  ): string | undefined => {
    const branch = ctx.sessionManager.getBranch();
    const entryIds = branch.map((e) => e.id);

    const targetIdx = entryIds.indexOf(targetEntryId);
    if (targetIdx === -1) return undefined;

    for (let i = targetIdx; i >= 0; i--) {
      const stashRef = checkpoints.get(entryIds[i]);
      if (stashRef) return stashRef;
    }

    return undefined;
  };

  /**
   * Find the checkpoint for an arbitrary entry ID across all session entries.
   * Used when the target is on a child branch (not on the active branch).
   * Walks the full entry list to find the nearest user message with a checkpoint.
   */
  const findCheckpointForAnyEntry = (
    ctx: ExtensionContext,
    targetEntryId: string,
  ): string | undefined => {
    const allEntries = ctx.sessionManager.getEntries();
    const entryIds = allEntries.map((e) => e.id);

    const targetIdx = entryIds.indexOf(targetEntryId);
    if (targetIdx === -1) return undefined;

    // Walk backward through ALL entries (not just the active branch)
    // to find the nearest checkpoint. Since entries are stored in
    // chronological order, entries near the target are likely related.
    for (let i = targetIdx; i >= 0; i--) {
      const stashRef = checkpoints.get(entryIds[i]);
      if (stashRef) return stashRef;
    }

    return undefined;
  };

  /**
   * Find the deepest leaf on a child branch.
   *
   * After /undo, the active branch ends at the user message.
   * The original assistant response and subsequent entries are children
   * of that user message. Walk down the child tree to find the leaf.
   *
   * Prefers non-summary children (skips branch_summary entries).
   */
  const findChildBranchLeaf = (
    ctx: ExtensionContext,
    parentId: string,
  ): string | undefined => {
    const children = ctx.sessionManager.getChildren(parentId);
    if (!children || children.length === 0) return undefined;

    // Prefer non-summary children (the actual conversation branch)
    const entryChild =
      children.find((c: any) => c.type !== "branch_summary") ?? children[0];

    // Walk down to the leaf
    let current = entryChild;
    for (;;) {
      const nextChildren = ctx.sessionManager.getChildren((current as any).id);
      if (!nextChildren || nextChildren.length === 0) break;

      const nextChild =
        nextChildren.find((c: any) => c.type !== "branch_summary") ??
        nextChildren[0];
      current = nextChild;
    }

    return (current as any).id;
  };

  /**
   * Find the best checkpoint for a given entry ID.
   *
   * The checkpoint keyed by entryId captures the state BEFORE the agent acted
   * on that user message. But the newLeafId from /tree might be an assistant
   * message or tool result, not a user message. So we walk the branch entries
   * to find the nearest user message that has a checkpoint.
   *
   * Returns { stashRef, direction } where direction is "undo" or "redo"
   * relative to the previous leaf position.
   */
  const findCheckpointForLeaf = (
    ctx: ExtensionContext,
    newLeafId: string,
    oldLeafId?: string,
  ): { stashRef: string; direction: "undo" | "redo" } | undefined => {
    const branch = ctx.sessionManager.getBranch();

    // Build a list of entry IDs in branch order
    const entryIds = branch.map((e) => e.id);

    // Walk backward from newLeafId to find the closest entry with a checkpoint
    const newIdx = entryIds.indexOf(newLeafId);
    if (newIdx === -1) return undefined;

    for (let i = newIdx; i >= 0; i--) {
      const stashRef = checkpoints.get(entryIds[i]);
      if (stashRef) {
        // Determine direction by comparing positions
        const oldIdx = oldLeafId ? entryIds.indexOf(oldLeafId) : -1;
        const direction: "undo" | "redo" =
          oldIdx !== -1 && newIdx < oldIdx ? "undo" : "redo";

        return { stashRef, direction };
      }
    }

    return undefined;
  };

  /**
   * Restore working tree to match a checkpoint state.
   *
   * Uses `git checkout <ref> -- .` which directly sets the working tree + index
   * to the checkpoint's tree. This is a replacement, not a merge — it works
   * reliably regardless of whether HEAD has moved (e.g. user committed after
   * the checkpoint was created).
   *
   * After this, the working tree matches the checkpoint exactly.
   * Files show as staged changes (diff from HEAD to checkpoint state).
   * We unstage them so the result looks like normal dirty working tree changes.
   */
  const restoreToCheckpoint = async (
    stashRef: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    // Replace working tree + index with the exact tree from the stash commit.
    // This works regardless of where HEAD is (before or after user commits).
    const { code, stderr } = await pi.exec("git", [
      "checkout",
      stashRef,
      "--",
      ".",
    ]);
    if (code !== 0) {
      return { ok: false, error: stderr || "Unknown error" };
    }

    // Unstage so files appear as normal working tree changes,
    // not staged changes. This matches the original dirty-tree feel.
    await pi.exec("git", ["reset", "HEAD", "--", "."]);

    return { ok: true };
  };

  /**
   * Offer code restore for a checkpoint and apply if confirmed.
   */
  const offerCodeRestore = async (
    ctx: ExtensionCommandContext,
    stashRef: string,
    direction: "undo" | "redo",
    targetPreview: string,
  ): Promise<boolean> => {
    // Verify the stash object still exists
    if (!(await refExists(stashRef))) {
      ctx.ui.notify(
        "Checkpoint has expired (git GC cleaned it up). " +
          "Run pi more frequently or set gc.pruneExpire to keep checkpoints longer.",
        "error",
      );
      return false;
    }

    // Check if working tree differs from the checkpoint
    const { stdout: diffOutput } = await pi.exec("git", [
      "diff",
      "--stat",
      stashRef,
    ]);
    const hasChanges = diffOutput.trim().length > 0;
    if (!hasChanges) return true; // no code changes, just navigate

    if (!ctx.hasUI) return true; // non-interactive, just restore

    const label = direction === "undo" ? "Undo" : "Redo";
    const choice = await ctx.ui.select(
      `${label}: navigate to "${targetPreview}" — restore code?`,
      [
        "Yes, navigate and restore code",
        "Just navigate (keep current code)",
        "Cancel",
      ],
    );

    if (choice === "Cancel" || !choice) return false;

    if (choice.startsWith("Yes")) {
      const restore = await restoreToCheckpoint(stashRef);
      if (restore.ok) {
        ctx.ui.notify(`Code restored (${direction})`, "info");
      } else {
        ctx.ui.notify(
          `Failed to restore code:\n${restore.error}\nManually run: git checkout ${stashRef} -- .`,
          "error",
        );
      }
    }

    return true;
  };

  // Register /undo command
  pi.registerCommand("undo", {
    description:
      "Undo: undo the last agent response and optionally restore code",
    handler: async (_args, ctx) => {
      const userMessages = getUserMessages(ctx);
      if (userMessages.length === 0) {
        ctx.ui.notify("No user messages in this session", "error");
        return;
      }

      const currentLeafId = ctx.sessionManager.getLeafId();
      if (!currentLeafId) {
        ctx.ui.notify("No current position in session", "error");
        return;
      }

      // Find which user message the current leaf belongs to.
      // Walk backward from leaf to find the most recent user message at or before it.
      const branch = ctx.sessionManager.getBranch();
      const entryIds = branch.map((e) => e.id);
      const leafIdx = entryIds.indexOf(currentLeafId);

      let currentUserIdx = -1;
      for (let i = leafIdx; i >= 0; i--) {
        const userMsg = userMessages.find((u) => u.entryId === entryIds[i]);
        if (userMsg) {
          currentUserIdx = userMessages.indexOf(userMsg);
          break;
        }
      }

      if (currentUserIdx === -1) {
        ctx.ui.notify("Cannot determine current position", "error");
        return;
      }

      // If leaf is past a user message (on assistant/tool entry),
      // undo navigates to that user message — undoing the agent's response.
      // If leaf is already ON a user message (from a previous undo),
      // undo goes one step further back.
      const leafIsOnUserMessage =
        userMessages[currentUserIdx].entryId === currentLeafId;
      const targetIdx = leafIsOnUserMessage
        ? currentUserIdx - 1
        : currentUserIdx;

      if (targetIdx < 0) {
        ctx.ui.notify("Already at the earliest point", "error");
        return;
      }

      const target = userMessages[targetIdx];

      // Offer code restore before navigating
      const stashRef = findCheckpointForEntry(ctx, target.entryId);
      if (stashRef) {
        const proceed = await offerCodeRestore(
          ctx,
          stashRef,
          "undo",
          target.preview,
        );
        if (!proceed) return;
      }

      // Push current leaf to redo stack so /redo can navigate back
      redoStack.push(currentLeafId);

      // Suppress session_tree handler's code restore prompt
      // (we already handled it above)
      skipTreeCodeRestore = true;

      // Navigate the session tree — rewinds conversation
      await ctx.navigateTree(target.entryId);
      ctx.ui.notify(`Undo: navigated to "${target.preview}"`, "info");
    },
  });

  // Register /redo command
  pi.registerCommand("redo", {
    description:
      "Redo: navigate forward after undo and optionally restore code",
    handler: async (_args, ctx) => {
      // First: try the redo stack (most reliable — exact previous position)
      if (redoStack.length > 0) {
        const redoTargetId = redoStack.pop()!;

        // Find checkpoint for the redo target
        const stashRef = findCheckpointForAnyEntry(ctx, redoTargetId);
        if (stashRef) {
          const proceed = await offerCodeRestore(
            ctx,
            stashRef,
            "redo",
            `previous position`,
          );
          if (!proceed) {
            // Put it back — user cancelled
            redoStack.push(redoTargetId);
            return;
          }
        }

        // Suppress session_tree handler's code restore prompt
        skipTreeCodeRestore = true;

        await ctx.navigateTree(redoTargetId);
        ctx.ui.notify("Redo: navigated to previous position", "info");
        return;
      }

      // Fallback: no redo stack, try to find the next user message
      // or walk to a child branch leaf
      const userMessages = getUserMessages(ctx);
      const currentLeafId = ctx.sessionManager.getLeafId();
      if (!currentLeafId) {
        ctx.ui.notify("No current position in session", "error");
        return;
      }

      const branch = ctx.sessionManager.getBranch();
      const entryIds = branch.map((e) => e.id);
      const leafIdx = entryIds.indexOf(currentLeafId);

      // Find the user message at or before current leaf
      let currentUserIdx = -1;
      for (let i = leafIdx; i >= 0; i--) {
        const userMsg = userMessages.find((u) => u.entryId === entryIds[i]);
        if (userMsg) {
          currentUserIdx = userMessages.indexOf(userMsg);
          break;
        }
      }

      if (currentUserIdx === -1) {
        ctx.ui.notify("Cannot determine current position", "error");
        return;
      }

      // Try next user message on the active branch
      const nextUserIdx = currentUserIdx + 1;
      if (nextUserIdx < userMessages.length) {
        const target = userMessages[nextUserIdx];
        const stashRef = findCheckpointForEntry(ctx, target.entryId);
        if (stashRef) {
          const proceed = await offerCodeRestore(
            ctx,
            stashRef,
            "redo",
            target.preview,
          );
          if (!proceed) return;
        }

        skipTreeCodeRestore = true;
        await ctx.navigateTree(target.entryId);
        ctx.ui.notify(`Redo: navigated to "${target.preview}"`, "info");
        return;
      }

      // No next user message on active branch.
      // The current leaf is ON a user message (after undo).
      // Look for child branches (the undone assistant response).
      const childLeafId = findChildBranchLeaf(ctx, currentLeafId);
      if (childLeafId) {
        const stashRef = findCheckpointForAnyEntry(ctx, childLeafId);
        if (stashRef) {
          const proceed = await offerCodeRestore(
            ctx,
            stashRef,
            "redo",
            `assistant response`,
          );
          if (!proceed) return;
        }

        skipTreeCodeRestore = true;
        await ctx.navigateTree(childLeafId);
        ctx.ui.notify("Redo: navigated to assistant response", "info");
        return;
      }

      ctx.ui.notify("Already at the latest point", "error");
    },
  });

  // Undo/redo via /tree navigation (for manual tree browsing)
  pi.on("session_tree", async (event, ctx) => {
    // Skip if /undo or /redo already handled code restore
    if (skipTreeCodeRestore) {
      skipTreeCodeRestore = false;
      return;
    }

    const targetEntryId = event.newLeafId;
    if (!targetEntryId) return;

    const result = findCheckpointForLeaf(ctx, targetEntryId, event.oldLeafId);
    if (!result) return;

    const { stashRef, direction } = result;

    // Verify the stash object still exists (may have been GC'd)
    if (!(await refExists(stashRef))) {
      ctx.ui.notify(
        "Checkpoint has expired (git GC cleaned it up). " +
          "Run pi more frequently or set gc.pruneExpire to keep checkpoints longer.",
        "error",
      );
      return;
    }

    if (!ctx.hasUI) return;

    // Check if working tree differs from the checkpoint
    const { stdout: diffOutput } = await pi.exec("git", [
      "diff",
      "--stat",
      stashRef,
    ]);
    const hasChanges = diffOutput.trim().length > 0;
    if (!hasChanges) return;

    const label = direction === "undo" ? "Undo" : "Redo";
    const choice = await ctx.ui.select(
      `${label}: restore code to this point?`,
      ["Yes, restore code", "No, keep current code"],
    );

    if (choice?.startsWith("Yes")) {
      const restore = await restoreToCheckpoint(stashRef);
      if (restore.ok) {
        ctx.ui.notify(`Code restored (${direction})`, "info");
      } else {
        ctx.ui.notify(
          `Failed to restore code:\n${restore.error}\nManually run: git checkout ${stashRef} -- .`,
          "error",
        );
      }
    }
  });

  // Also support restore when forking
  pi.on("session_before_fork", async (event, ctx) => {
    const stashRef = checkpoints.get(event.entryId);
    if (!stashRef) return;

    // Verify ref still exists
    if (!(await refExists(stashRef))) {
      ctx.ui.notify("Checkpoint has expired (git GC cleaned it up)", "error");
      return;
    }

    if (!ctx.hasUI) return;

    const choice = await ctx.ui.select("Restore code to this point?", [
      "Yes, restore code",
      "No, keep current code",
    ]);

    if (choice?.startsWith("Yes")) {
      const restore = await restoreToCheckpoint(stashRef);
      if (restore.ok) {
        ctx.ui.notify("Code restored", "info");
      } else {
        ctx.ui.notify(
          `Failed to restore code:\n${restore.error}\nManually run: git checkout ${stashRef} -- .`,
          "error",
        );
      }
    }
  });
}
