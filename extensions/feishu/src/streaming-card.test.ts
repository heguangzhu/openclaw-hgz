import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  FeishuStreamingSession,
  mergeStreamingText,
  resolveStreamingCardSendMode,
} from "./streaming-card.js";

type StreamingSessionState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  hasNote: boolean;
};

function setStreamingSessionInternals(
  session: FeishuStreamingSession,
  values: {
    state: StreamingSessionState;
    lastUpdateTime?: number;
  },
) {
  const internals = session as unknown as {
    state: StreamingSessionState;
    lastUpdateTime: number;
  };
  internals.state = values.state;
  if (values.lastUpdateTime !== undefined) {
    internals.lastUpdateTime = values.lastUpdateTime;
  }
}

describe("FeishuStreamingSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset();
  });

  function mockFetches(updateBodies: string[]) {
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ url, init }: { url: string; init?: { body?: string } }) => {
        const release = vi.fn(async () => {});
        if (url.includes("/auth/")) {
          return {
            response: {
              ok: true,
              json: async () => ({
                code: 0,
                msg: "ok",
                tenant_access_token: "token",
                expire: 7200,
              }),
            },
            release,
          };
        }
        if (url.includes("/elements/content/content")) {
          updateBodies.push(init?.body ?? "");
        }
        return {
          response: {
            ok: true,
            json: async () => ({ code: 0, msg: "ok" }),
          },
          release,
        };
      },
    );
  }

  it("flushes throttled pending text after the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const updateBodies: string[] = [];
    mockFetches(updateBodies);

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_pending_flush",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_1",
        messageId: "om_1",
        sequence: 1,
        currentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 1_000,
    });

    await session.update("hello small");
    expect(updateBodies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(160);

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toMatchObject({
      content: "hello small",
    });
  });

  it("pushes natural-boundary updates immediately inside the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const updateBodies: string[] = [];
    mockFetches(updateBodies);

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_boundary_flush",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_2",
        messageId: "om_2",
        sequence: 1,
        currentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello!");

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toMatchObject({
      content: "hello!",
    });
  });

  it("falls back to a plain reply and short-circuits future updates on 300309", async () => {
    const updateBodies: string[] = [];
    const replyCalls: Array<{ path: { message_id: string }; data: { content: string } }> = [];
    let putCount = 0;
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ url, init }: { url: string; init?: { body?: string } }) => {
        const release = vi.fn(async () => {});
        if (url.includes("/auth/")) {
          return {
            response: {
              ok: true,
              json: async () => ({
                code: 0,
                msg: "ok",
                tenant_access_token: "token",
                expire: 7200,
              }),
            },
            release,
          };
        }
        if (url.includes("/elements/content/content")) {
          updateBodies.push(init?.body ?? "");
          putCount += 1;
          // Simulate Feishu having closed the stream window mid-update.
          return {
            response: {
              ok: true,
              json: async () => ({ code: 300309, msg: "ErrMsg: streaming mode is closed" }),
            },
            release,
          };
        }
        return {
          response: { ok: true, json: async () => ({ code: 0, msg: "ok" }) },
          release,
        };
      },
    );

    const fakeClient = {
      im: {
        message: {
          reply: vi.fn(
            async (args: { path: { message_id: string }; data: { content: string } }) => {
              replyCalls.push(args);
              return { code: 0, msg: "ok", data: { message_id: "om_fallback" } };
            },
          ),
        },
      },
    } as unknown as Parameters<typeof FeishuStreamingSession.prototype.constructor>[0];

    const logs: string[] = [];
    const session = new FeishuStreamingSession(
      fakeClient,
      { appId: "app_300309", appSecret: "secret" },
      (msg) => logs.push(msg),
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_300309",
        messageId: "om_streaming_dead",
        sequence: 1,
        currentText: "已采集 27 条达人，",
        hasNote: false,
      },
      lastUpdateTime: 0,
    });

    // First update returns 300309 — should trigger fallback reply and mark
    // the session server-closed.
    await session.update("已采集 27 条达人，开始建库。");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(putCount).toBe(1);
    expect(replyCalls).toHaveLength(1);
    expect(JSON.parse(replyCalls[0]?.data.content ?? "{}")).toEqual({
      text: "已采集 27 条达人，开始建库。",
    });
    expect(replyCalls[0]?.path.message_id).toBe("om_streaming_dead");

    // Subsequent update() must short-circuit — no extra PUT, no extra reply.
    await session.update("已采集 27 条达人，开始建库。已写入数据库。");
    await new Promise((resolve) => setImmediate(resolve));
    expect(putCount).toBe(1);
    expect(replyCalls).toHaveLength(1);

    // close() with the same finalText must not produce a duplicate reply.
    await session.close("已采集 27 条达人，开始建库。");
    expect(replyCalls).toHaveLength(1);

    expect(logs.some((m) => m.includes("code=300309"))).toBe(true);
    expect(logs.some((m) => m.includes("Sent fallback plain reply"))).toBe(true);
  });

  it("close() after 300309 with a richer finalText sends a follow-up reply", async () => {
    const replyCalls: Array<{ data: { content: string } }> = [];
    let putCount = 0;
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      const release = vi.fn(async () => {});
      if (url.includes("/auth/")) {
        return {
          response: {
            ok: true,
            json: async () => ({
              code: 0,
              msg: "ok",
              tenant_access_token: "token",
              expire: 7200,
            }),
          },
          release,
        };
      }
      if (url.includes("/elements/content/content")) {
        putCount += 1;
        return {
          response: {
            ok: true,
            json: async () => ({ code: 300309, msg: "ErrMsg: streaming mode is closed" }),
          },
          release,
        };
      }
      return {
        response: { ok: true, json: async () => ({ code: 0, msg: "ok" }) },
        release,
      };
    });

    const fakeClient = {
      im: {
        message: {
          reply: vi.fn(async (args: { data: { content: string } }) => {
            replyCalls.push(args);
            return { code: 0, msg: "ok", data: { message_id: "om_x" } };
          }),
        },
      },
    } as unknown as Parameters<typeof FeishuStreamingSession.prototype.constructor>[0];

    const session = new FeishuStreamingSession(fakeClient, {
      appId: "app_close_after_300309",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_partial",
        messageId: "om_partial",
        sequence: 1,
        currentText: "partial",
        hasNote: false,
      },
      lastUpdateTime: 0,
    });

    await session.update("partial answer");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(replyCalls).toHaveLength(1);
    expect(JSON.parse(replyCalls[0]?.data.content ?? "{}")).toEqual({
      text: "partial answer",
    });

    // close() with a different (richer) finalText should send a follow-up reply
    // so the user actually receives the authoritative final answer, not the
    // mid-stream snapshot.
    await session.close("partial answer plus the final paragraph");

    expect(putCount).toBe(1);
    expect(replyCalls).toHaveLength(2);
    expect(JSON.parse(replyCalls[1]?.data.content ?? "{}")).toEqual({
      text: "partial answer plus the final paragraph",
    });
  });
});

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("好的，让我", "让我再读取一遍")).toBe("好的，让我再读取一遍");
    expect(mergeStreamingText("revision_id: 552", "2，一点变化都没有")).toBe(
      "revision_id: 552，一点变化都没有",
    );
    expect(mergeStreamingText("abc", "cabc")).toBe("cabc");
  });
});

describe("resolveStreamingCardSendMode", () => {
  it("prefers message.reply when reply target and root id both exist", () => {
    expect(
      resolveStreamingCardSendMode({
        replyToMessageId: "om_parent",
        rootId: "om_topic_root",
      }),
    ).toBe("reply");
  });

  it("falls back to root create when reply target is absent", () => {
    expect(
      resolveStreamingCardSendMode({
        rootId: "om_topic_root",
      }),
    ).toBe("root_create");
  });

  it("uses create mode when no reply routing fields are provided", () => {
    expect(resolveStreamingCardSendMode()).toBe("create");
    expect(
      resolveStreamingCardSendMode({
        replyInThread: true,
      }),
    ).toBe("create");
  });
});
