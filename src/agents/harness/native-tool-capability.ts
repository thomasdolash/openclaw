/**
 * Shared native-tool construction and capability binding for AgentHarness.
 *
 * This module provides:
 *   - buildAttemptNativeTools — shared construction + policy filtering used by
 *     both runEmbeddedAttempt and runAgentHarnessAttempt (extracted to avoid
 *     duplicate tool construction logic).
 *   - buildAgentHarnessNativeToolCapability — builds serializable definitions
 *     and an attempt-bound executor for the intersection of OpenClaw tool
 *     policy and harness-declared capability.
 */
import { getPluginToolMeta } from "../../plugins/tools.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  buildToolLifecycleErrorResult,
  sanitizeToolResult,
} from "../embedded-agent-subscribe.tools.js";
import { isToolResultError } from "../tool-result-error.js";
import type { AnyAgentTool } from "../tools/common.js";
import type {
  AgentHarnessNativeToolExecutor,
  AgentHarnessNativeToolResult,
  AgentHarnessToolDefinition,
} from "./types.js";

/**
 * Shared tool construction helper used by the embedded attempt runner and
 * agent harness selection. Constructs OpenClaw coding tools from the given
 * context, then filters them through the effective tool allowlist.
 *
 * Extracted from the tool-construction IIFE in attempt.ts so that both
 * runEmbeddedAttempt and runAgentHarnessAttempt use exactly the same
 * construction and filtering behavior.
 */
export function buildAttemptNativeTools(
  toolContext: Parameters<typeof createOpenClawCodingTools>[0],
  toolsAllow: string[] | undefined,
): AnyAgentTool[] {
  const allTools = createOpenClawCodingTools(toolContext);
  return applyEmbeddedAttemptToolsAllow(allTools, toolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
}

/**
 * Given a policy-filtered native tool array and an optional set of harness-
 * declared tool names, builds:
 *   1. Serializable AgentHarnessToolDefinition[] for only the intersection.
 *   2. An attempt-bound executor limited to that intersection.
 *
 * The executor follows the verified normal tool path:
 *   - prepareArguments when present
 *   - tool.execute(callId, preparedArgs, signal, onUpdate?)
 *   - sanitizeToolResult for result normalisation
 *   - isToolResultError for error classification
 *   - onAgentToolResult callback delivery
 *   - Thrown errors are caught and returned as deterministic error results.
 */
export function buildAgentHarnessNativeToolCapability(
  filteredTools: AnyAgentTool[],
  nativeToolNames: string[] | undefined,
  onAgentToolResult?: (event: { toolName: string; result: unknown; isError: boolean }) => void,
): {
  definitions: AgentHarnessToolDefinition[];
  executor: AgentHarnessNativeToolExecutor;
} {
  // Build a full-name map from the policy-filtered tool array
  const allToolsByName = new Map<string, AnyAgentTool>();
  for (const tool of filteredTools) {
    allToolsByName.set(tool.name, tool);
  }

  // Determine the effective tool name set: intersection of policy-filtered
  // tools and harness-declared capability. When the harness does not declare
  // a capability filter, all policy-filtered tools are exposed.
  const effectiveNames: string[] = nativeToolNames
    ? nativeToolNames.filter((name) => allToolsByName.has(name))
    : [...allToolsByName.keys()];

  // Build serializable definitions for only the effective names
  const definitions: AgentHarnessToolDefinition[] = [];
  const executorToolMap = new Map<string, AnyAgentTool>();
  for (const name of effectiveNames) {
    const tool = allToolsByName.get(name)!;
    definitions.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    executorToolMap.set(name, tool);
  }

  // Build the attempt-bound executor restricted to the effective names
  const executor: AgentHarnessNativeToolExecutor = async (request) => {
    const tool = executorToolMap.get(request.toolName);
    if (!tool) {
      const error = `Unknown or unavailable native tool: ${request.toolName}`;
      const errorResult = buildToolLifecycleErrorResult(new Error(error));
      const result: AgentHarnessNativeToolResult = {
        content: [{ type: "text", text: error }],
        details: errorResult.details,
        isError: true,
      };
      onAgentToolResult?.({
        toolName: request.toolName,
        result,
        isError: true,
      });
      return result;
    }

    let preparedArgs: unknown;
    try {
      preparedArgs =
        typeof tool.prepareArguments === "function"
          ? tool.prepareArguments(request.arguments)
          : request.arguments;
    } catch (error) {
      const errorResult = buildToolLifecycleErrorResult(error);
      const result: AgentHarnessNativeToolResult = {
        content: [{ type: "text", text: `Argument preparation failed: ${String(error)}` }],
        details: errorResult.details,
        isError: true,
      };
      onAgentToolResult?.({
        toolName: request.toolName,
        result,
        isError: true,
      });
      return result;
    }

    let rawResult: unknown;
    try {
      rawResult = await tool.execute(request.callId, preparedArgs, request.signal, undefined);
    } catch (error) {
      const errorResult = buildToolLifecycleErrorResult(error);
      const sanitized = sanitizeToolResult(errorResult);
      const isError = true;
      onAgentToolResult?.({ toolName: request.toolName, result: sanitized, isError });
      return {
        content: [{ type: "text", text: `Tool execution failed: ${String(error)}` }],
        details: errorResult.details,
        isError,
      };
    }

    const sanitized = sanitizeToolResult(rawResult);
    const isError = isToolResultError(sanitized);
    onAgentToolResult?.({ toolName: request.toolName, result: sanitized, isError });

    return {
      content: extractContent(sanitized),
      details: extractDetails(sanitized),
      isError,
    };
  };

  return { definitions, executor };
}

function extractContent(result: unknown): AgentHarnessNativeToolResult["content"] {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as Record<string, unknown>).content)
  ) {
    return (result as Record<string, unknown>).content as AgentHarnessNativeToolResult["content"];
  }
  return [];
}

function extractDetails(result: unknown): unknown {
  if (result && typeof result === "object") {
    return (result as Record<string, unknown>).details;
  }
  return undefined;
}
