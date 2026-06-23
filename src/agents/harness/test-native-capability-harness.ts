/**
 * Test-only AgentHarness fixtures for the native-tool capability validation.
 *
 * Provides:
 *   1. An opted-in harness declaring nativeToolCapability with sessions_send.
 *   2. A non-opted-in harness for compatibility tests.
 *
 * The fixtures do not:
 *   - reference OpenCode, MCP, ACPX, broker routes, or live Gateway
 *   - use a bespoke harness or custom session graph
 *   - add production harnesses or new registration mechanisms
 */
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessNativeToolExecutor,
  AgentHarnessToolDefinition,
} from "./types.js";

export type TestHarnessCapture = {
  params: AgentHarnessAttemptParams;
  definitions: AgentHarnessToolDefinition[];
  executor: AgentHarnessNativeToolExecutor;
};

export type TestHarnessMode =
  | { mode: "inspect" }
  | { mode: "invoke"; callToolName: string; callArgs: unknown }
  | { mode: "hold" }
  | { mode: "throw"; error: Error };

const testResult = (params: AgentHarnessAttemptParams): AgentHarnessAttemptResult =>
  ({
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId ?? "",
    sessionFileUsed: params.sessionFile,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  }) as AgentHarnessAttemptResult;

function buildHarness(
  id: string,
  label: string,
  capability: { tools?: string[] } | undefined,
  mode: TestHarnessMode,
  capture: TestHarnessCapture,
): AgentHarness {
  return {
    id,
    label,
    pluginId: undefined,
    contextEngineHostCapabilities: undefined,
    nativeToolCapability: capability,
    supports: () => ({ supported: true, priority: 10 }),
    runAttempt: async (params) => {
      capture.params = params;
      capture.definitions = params.nativeToolDefinitions ?? [];
      capture.executor = params.nativeToolExecutor!;

      if (mode.mode === "throw") {
        throw mode.error;
      }
      if (mode.mode === "invoke") {
        await params.nativeToolExecutor!({
          callId: "test-call-1",
          toolName: mode.callToolName,
          arguments: mode.callArgs,
        });
      }

      return testResult(params);
    },
  } as AgentHarness;
}

/**
 * Creates an opted-in test AgentHarness declaring:
 *   nativeToolCapability: { tools: ["sessions_send"] }
 */
export function createOptedInTestHarness(
  mode: TestHarnessMode = { mode: "inspect" },
): AgentHarness & { _capture: TestHarnessCapture } {
  const capture: TestHarnessCapture = {
    params: {} as AgentHarnessAttemptParams,
    definitions: [],
    executor: {} as AgentHarnessNativeToolExecutor,
  };
  const harness = buildHarness(
    "test-native-capability",
    "Test native capability harness",
    { tools: ["sessions_send"] },
    mode,
    capture,
  );
  return Object.assign(harness, { _capture: capture });
}

/**
 * Creates a non-opted-in test AgentHarness (no nativeToolCapability).
 */
export function createNonOptedInTestHarness(): AgentHarness & { _capture: TestHarnessCapture } {
  const capture: TestHarnessCapture = {
    params: {} as AgentHarnessAttemptParams,
    definitions: [],
    executor: {} as AgentHarnessNativeToolExecutor,
  };
  const harness = buildHarness(
    "test-no-capability",
    "Test non-opted-in harness",
    undefined,
    { mode: "inspect" },
    capture,
  );
  return Object.assign(harness, { _capture: capture });
}
