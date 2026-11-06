/**
 * permissions.ts — Load permissions.json and resolve the permission extension path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentConfig } from "./config.ts";

export interface PermissionRule {
  tool: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
  description?: string;
}

export interface PermissionConfig {
  rules?: PermissionRule[];
  defaults?: Record<string, string>;
  defaultAction?: string;
}

export function loadPermissions(config: SubagentConfig): PermissionConfig {
  const permPath = config.permissionConfigPath;
  if (!existsSync(permPath)) return { rules: [] };

  try {
    const raw = readFileSync(permPath, "utf8");
    return JSON.parse(raw) as PermissionConfig;
  } catch {
    return { rules: [] };
  }
}

/** Check if any permission rule uses 'ask' or 'deny' for write-capable tools. */
export function hasRestrictiveRules(permConfig: PermissionConfig): boolean {
  if (!permConfig.rules) return false;
  return permConfig.rules.some(
    (r) =>
      (r.action === "ask" || r.action === "deny") &&
      ["write", "edit", "bash"].includes(r.tool),
  );
}

/** Resolve the permission extension path. */
export function resolvePermissionExtensionPath(
  config: SubagentConfig,
): string | null {
  const extPath = config.permissionExtensionPath;
  if (!extPath) return null;
  if (existsSync(extPath)) return extPath;
  return null;
}
