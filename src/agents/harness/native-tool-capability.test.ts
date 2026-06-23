// Focused behavior tests for the native-tool-capability helper.
// Tests the executor contract, error classification, argument preparation,
// and subset intersection without constructing full OpenClaw tool instances.
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../tools/common.js";
import { buildAgentHarnessNativeToolCapability } from "./native-tool-capability.js";

function mockTool(overrides: Partial<AnyAgentTool> & { name: string }): AnyAgentTool {
  return {
    description: `mock ${overrides.name}`,
    parameters: { type: "object", properties: {} },
    prepareArguments: undefined,
    execute: vi.fn<any>().mockResolvedValue({
      content: [{ type: "text", text: `${overrides.name} done` }],
      details: { status: "ok" },
    }),
    ...overrides,
  } as AnyAgentTool;
}

describe("buildAgentHarnessNativeToolCapability", () => {
  it("returns empty definitions and executor for empty tool array", () => {
    const { definitions, executor } = buildAgentHarnessNativeToolCapability([], undefined);
    expect(definitions).toEqual([]);
  });

  it("exposes all tools when no capability filter is set", () => {
    const tools = [mockTool({ name: "read" }), mockTool({ name: "write" })];
    const { definitions } = buildAgentHarnessNativeToolCapability(tools, undefined);
    expect(definitions).toHaveLength(2);
    expect(definitions.map((d) => d.name).sort()).toEqual(["read", "write"]);
  });

  it("intersects tools with capability filter", () => {
    const tools = [
      mockTool({ name: "read" }),
      mockTool({ name: "write" }),
      mockTool({ name: "sessions_send" }),
    ];
    const { definitions } = buildAgentHarnessNativeToolCapability(tools, ["sessions_send", "read"]);
    expect(definitions.map((d) => d.name).sort()).toEqual(["read", "sessions_send"]);
  });

  it("excludes tools not in capability filter", () => {
    const tools = [mockTool({ name: "read" }), mockTool({ name: "write" })];
    const { definitions } = buildAgentHarnessNativeToolCapability(tools, ["read"]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].name).toBe("read");
  });

  it("excludes tools not in policy-filtered set even when capability names include them", () => {
    const tools = [mockTool({ name: "read" })];
    const { definitions } = buildAgentHarnessNativeToolCapability(tools, ["read", "exec"]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].name).toBe("read");
  });

  it("includes description and parameters in definitions", () => {
    const tool = mockTool({
      name: "sessions_send",
      description: "Send a message to a session",
      parameters: { type: "object", properties: { message: { type: "string" } } },
    });
    const { definitions } = buildAgentHarnessNativeToolCapability([tool], ["sessions_send"]);
    expect(definitions[0].description).toBe("Send a message to a session");
    expect(definitions[0].parameters).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  describe("executor", () => {
    it("rejects unknown tool names with a deterministic error result", async () => {
      const tools = [mockTool({ name: "read" })];
      const { executor } = buildAgentHarnessNativeToolCapability(tools, ["read"]);
      const result = await executor({ callId: "c1", toolName: "exec", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown or unavailable native tool: exec");
    });

    it("calls prepareArguments before execute", async () => {
      const prepareArguments = vi.fn((args: unknown) => ({ ...(args as object), prepared: true }));
      const execute = vi.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        details: { status: "ok" },
      });
      const tool = mockTool({ name: "test_tool", prepareArguments, execute });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["test_tool"]);
      await executor({ callId: "c1", toolName: "test_tool", arguments: { x: 1 } });
      expect(prepareArguments).toHaveBeenCalledWith({ x: 1 });
      expect(execute).toHaveBeenCalledWith("c1", { x: 1, prepared: true }, undefined, undefined);
    });

    it("skips prepareArguments when the tool has none", async () => {
      const execute = vi.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        details: { status: "ok" },
      });
      const tool = mockTool({ name: "simple", execute });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["simple"]);
      await executor({ callId: "c1", toolName: "simple", arguments: { x: 1 } });
      expect(execute).toHaveBeenCalledWith("c1", { x: 1 }, undefined, undefined);
    });

    it("returns a successful result with isError=false", async () => {
      const tool = mockTool({ name: "ok_tool" });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["ok_tool"]);
      const result = await executor({ callId: "c1", toolName: "ok_tool", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe("ok_tool done");
    });

    it("sets isError=true for native structured failure via details.status", async () => {
      const tool = mockTool({
        name: "fail_tool",
        execute: vi.fn<any>().mockResolvedValue({
          content: [{ type: "text", text: "failed" }],
          details: { status: "error", error: "something went wrong" },
        }),
      });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["fail_tool"]);
      const result = await executor({ callId: "c1", toolName: "fail_tool", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.details).toEqual({ status: "error", error: "something went wrong" });
    });

    it("sets isError=true for timeout status", async () => {
      const tool = mockTool({
        name: "timeout_tool",
        execute: vi.fn<any>().mockResolvedValue({
          content: [{ type: "text", text: "timed out" }],
          details: { status: "timeout" },
        }),
      });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["timeout_tool"]);
      const result = await executor({ callId: "c1", toolName: "timeout_tool", arguments: {} });
      expect(result.isError).toBe(true);
    });

    it("handles thrown tool errors with a normalized result", async () => {
      const tool = mockTool({
        name: "throw_tool",
        execute: vi.fn<any>().mockRejectedValue(new Error("internal failure")),
      });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["throw_tool"]);
      const result = await executor({ callId: "c1", toolName: "throw_tool", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("internal failure");
    });

    it("handles thrown prepareArguments errors", async () => {
      const tool = mockTool({
        name: "bad_args",
        prepareArguments: () => {
          throw new Error("bad arg format");
        },
      });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["bad_args"]);
      const result = await executor({ callId: "c1", toolName: "bad_args", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("bad arg format");
    });

    it("calls onAgentToolResult callback with success", async () => {
      const onAgentToolResult = vi.fn();
      const tool = mockTool({ name: "cb_tool" });
      const { executor } = buildAgentHarnessNativeToolCapability(
        [tool],
        ["cb_tool"],
        onAgentToolResult,
      );
      await executor({ callId: "c1", toolName: "cb_tool", arguments: {} });
      expect(onAgentToolResult).toHaveBeenCalledTimes(1);
      expect(onAgentToolResult).toHaveBeenCalledWith({
        toolName: "cb_tool",
        result: expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ text: "cb_tool done" })]),
        }),
        isError: false,
      });
    });

    it("calls onAgentToolResult callback with error for thrown execution", async () => {
      const onAgentToolResult = vi.fn();
      const tool = mockTool({
        name: "throw_cb",
        execute: vi.fn<any>().mockRejectedValue(new Error("boom")),
      });
      const { executor } = buildAgentHarnessNativeToolCapability(
        [tool],
        ["throw_cb"],
        onAgentToolResult,
      );
      await executor({ callId: "c1", toolName: "throw_cb", arguments: {} });
      expect(onAgentToolResult).toHaveBeenCalledWith({
        toolName: "throw_cb",
        result: expect.objectContaining({}),
        isError: true,
      });
    });

    it("preserves content array in successful results", async () => {
      const tool = mockTool({
        name: "content_tool",
        execute: vi.fn<any>().mockResolvedValue({
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          details: { status: "ok", count: 2 },
        }),
      });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["content_tool"]);
      const result = await executor({ callId: "c1", toolName: "content_tool", arguments: {} });
      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toBe("first");
      expect(result.content[1].text).toBe("second");
      expect(result.details).toEqual({ status: "ok", count: 2 });
    });

    it("propagates abortSignal to tool.execute", async () => {
      const abortController = new AbortController();
      const execute = vi.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        details: { status: "ok" },
      });
      const tool = mockTool({ name: "abort_tool", execute });
      const { executor } = buildAgentHarnessNativeToolCapability([tool], ["abort_tool"]);
      await executor({
        callId: "c1",
        toolName: "abort_tool",
        arguments: {},
        signal: abortController.signal,
      });
      expect(execute).toHaveBeenCalledWith("c1", {}, abortController.signal, undefined);
    });
  });
});
