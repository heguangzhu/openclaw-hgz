/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { getFeishuUserAgent } from "./client.js";
import { resolveFeishuCardTemplate, type CardHeaderConfig } from "./send.js";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  hasNote: boolean;
};

/** Options for customising the initial streaming card appearance. */
export type StreamingCardOptions = {
  /** Optional header with title and color template. */
  header?: CardHeaderConfig;
  /** Optional grey note footer text. */
  note?: string;
};

/** Optional header for streaming cards (title bar with color template) */
export type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

type StreamingStartOptions = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  header?: StreamingCardHeader;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token",
  });
  if (!response.ok) {
    await release();
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  await release();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  if (next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }

  // Merge partial overlaps, e.g. "这" + "这是" => "这是".
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

export function resolveStreamingCardSendMode(options?: StreamingStartOptions) {
  if (options?.replyToMessageId) {
    return "reply";
  }
  if (options?.rootId) {
    return "root_create";
  }
  return "create";
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private pendingText: string | null = null;
  private inFlight = false;

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingCardOptions & StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const elements: Record<string, unknown>[] = [
      { tag: "markdown", content: "⏳ Thinking...", element_id: "content" },
    ];
    if (options?.note) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: `<font color='grey'>${options.note}</font>`,
        element_id: "note",
      });
    }
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: { elements },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
      };
    }

    // Create card entity
    const { response: createRes, release: releaseCreate } = await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
          "User-Agent": getFeishuUserAgent(),
        },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.create",
    });
    if (!createRes.ok) {
      await releaseCreate();
      throw new Error(`Create card request failed with HTTP ${createRes.status}`);
    }
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    await releaseCreate();
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Prefer message.reply when we have a reply target — reply_in_thread
    // reliably routes streaming cards into Feishu topics, whereas
    // message.create with root_id may silently ignore root_id for card
    // references (card_id format).
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await this.client.im.message.reply({
        path: { message_id: sendOptions.replyToMessageId! },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else if (sendMode === "root_create") {
      // root_id is undeclared in the SDK types but accepted at runtime
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: Object.assign(
          { receive_id: receiveId, msg_type: "interactive", content: cardContent },
          { root_id: sendOptions.rootId },
        ),
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
      hasNote: !!options?.note,
    };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  private async inspectResponse(
    label: string,
    sequence: number,
    response: Response,
    textLen: number,
  ): Promise<void> {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (e) {
      console.error(
        `[DIAG-RESP] ${new Date().toISOString()} ${label} seq=${sequence} status=${response.status} body-read-failed=${String(e)}`,
      );
      return;
    }
    let code: unknown = undefined;
    let msg: unknown = undefined;
    try {
      const parsed = JSON.parse(bodyText) as { code?: unknown; msg?: unknown };
      code = parsed?.code;
      msg = parsed?.msg;
    } catch {
      // Non-JSON body — log raw snippet
    }
    const isHttpOk = response.status >= 200 && response.status < 300;
    const isBizOk = code === 0;
    if (!isHttpOk || !isBizOk) {
      const snippet = bodyText.length > 300 ? `${bodyText.slice(0, 300)}…` : bodyText;
      console.error(
        `[DIAG-RESP] ${new Date().toISOString()} ${label} seq=${sequence} textLen=${textLen} status=${response.status} code=${String(code)} msg=${String(msg)} body=${snippet}`,
      );
    } else {
      console.error(
        `[DIAG-RESP] ${new Date().toISOString()} ${label} seq=${sequence} textLen=${textLen} status=${response.status} code=0 ok`,
      );
    }
  }

  private async updateCardContent(text: string, onError?: (error: unknown) => void): Promise<void> {
    if (!this.state) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    const seq = this.state.sequence;
    const textLen = text.length;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
          "User-Agent": getFeishuUserAgent(),
        },
        body: JSON.stringify({
          content: text,
          sequence: seq,
          uuid: `s_${this.state.cardId}_${seq}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.update",
    })
      .then(async ({ response, release }) => {
        await this.inspectResponse("update", seq, response, textLen);
        await release();
      })
      .catch((error) => onError?.(error));
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const base = this.pendingText ?? this.state.currentText;
    const mergedInput = mergeStreamingText(base, text);
    if (!mergedInput || mergedInput === this.state.currentText) {
      return;
    }
    this.pendingText = mergedInput;

    // If a flush loop is already running, it will pick up the latest pendingText
    // when its current HTTP request resolves. Returning immediately here lets
    // callers coalesce many update() calls into at most one in-flight request.
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    this.queue = this.queue.then(async () => {
      try {
        while (!this.closed && this.state && this.pendingText !== null) {
          const target = this.pendingText;
          this.pendingText = null;
          if (target === this.state.currentText) {
            continue;
          }
          this.state.currentText = target;
          await this.updateCardContent(target, (e) => this.log?.(`Update failed: ${String(e)}`));
        }
      } finally {
        this.inFlight = false;
      }
    });
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    const seq = this.state.sequence;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
          "User-Agent": getFeishuUserAgent(),
        },
        body: JSON.stringify({
          content: `<font color='grey'>${note}</font>`,
          sequence: seq,
          uuid: `n_${this.state.cardId}_${seq}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.note-update",
    })
      .then(async ({ response, release }) => {
        await this.inspectResponse("note-update", seq, response, note.length);
        await release();
      })
      .catch((e) => this.log?.(`Note update failed: ${String(e)}`));
  }

  async close(finalText?: string, options?: { note?: string }): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    await this.queue;

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;
    const apiBase = resolveApiBase(this.creds.domain);
    const allowedHostnames = resolveAllowedHostnames(this.creds.domain);
    const cardId = this.state.cardId;
    const needsFinalUpdate = !!text && text !== this.state.currentText;
    const wantsNote = !!options?.note && this.state.hasNote;

    const token = await getToken(this.creds);
    const baseHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": getFeishuUserAgent(),
    };

    // Feishu's sequence check is card-wide, not per-element_id: a request with
    // sequence < max-seen-on-this-card is rejected with code 300317 even if it
    // targets a different element. So content/note/settings must be issued
    // strictly sequentially — any parallelism races and silently drops the
    // lower-seq write.
    if (needsFinalUpdate) {
      this.state.sequence += 1;
      const finalSeq = this.state.sequence;
      this.state.currentText = text;
      await fetchWithSsrFGuard({
        url: `${apiBase}/cardkit/v1/cards/${cardId}/elements/content/content`,
        init: {
          method: "PUT",
          headers: baseHeaders,
          body: JSON.stringify({
            content: text,
            sequence: finalSeq,
            uuid: `s_${cardId}_${finalSeq}`,
          }),
        },
        policy: { allowedHostnames },
        auditContext: "feishu.streaming-card.update",
      })
        .then(async ({ response, release }) => {
          await this.inspectResponse("close-update", finalSeq, response, text.length);
          await release();
        })
        .catch((e) => this.log?.(`Final update failed: ${String(e)}`));
    }

    if (wantsNote) {
      this.state.sequence += 1;
      const finalNoteSeq = this.state.sequence;
      await fetchWithSsrFGuard({
        url: `${apiBase}/cardkit/v1/cards/${cardId}/elements/note/content`,
        init: {
          method: "PUT",
          headers: baseHeaders,
          body: JSON.stringify({
            content: `<font color='grey'>${options!.note}</font>`,
            sequence: finalNoteSeq,
            uuid: `n_${cardId}_${finalNoteSeq}`,
          }),
        },
        policy: { allowedHostnames },
        auditContext: "feishu.streaming-card.note-update",
      })
        .then(async ({ response, release }) => {
          await this.inspectResponse("close-note", finalNoteSeq, response, options!.note!.length);
          await release();
        })
        .catch((e) => this.log?.(`Note update failed: ${String(e)}`));
    }

    this.state.sequence += 1;
    const closeSeq = this.state.sequence;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${cardId}/settings`,
      init: {
        method: "PATCH",
        headers: { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(text) } },
          }),
          sequence: closeSeq,
          uuid: `c_${cardId}_${closeSeq}`,
        }),
      },
      policy: { allowedHostnames },
      auditContext: "feishu.streaming-card.close",
    })
      .then(async ({ response, release }) => {
        await this.inspectResponse("close-settings", closeSeq, response, text.length);
        await release();
      })
      .catch((e) => this.log?.(`Close failed: ${String(e)}`));

    const finalState = this.state;
    this.state = null;
    this.pendingText = null;

    this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
