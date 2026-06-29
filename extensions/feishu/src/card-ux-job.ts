import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuCardInteractionContext } from "./card-ux-shared.js";
import { sendCardFeishu } from "./send.js";

// "来活啦" 触发词：群里 @机器人 或单聊发送该文本，弹出任务输入卡片。
// Trigger phrase: when a user @mentions the bot in a group (or DMs it) with this
// exact text, the bot replies with the job-input card instead of a normal reply.
export const FEISHU_JOB_TRIGGER_TEXT = "来活啦";

// 卡片提交动作标识，card-action.ts 用它识别这是"任务表单提交"。
export const FEISHU_JOB_SUBMIT_ACTION = "feishu.job.submit";

// 表单字段名（与卡片里 input/select 的 name 对应；提交时通过 form_value 回传）。
export const FEISHU_JOB_FIELD_INFO = "task_info";
export const FEISHU_JOB_FIELD_PLATFORM = "platform";

const FEISHU_JOB_CARD_TTL_MS = 30 * 60_000;

// ⬇⬇⬇ 平台下拉选项 ⬇⬇⬇
// Platform dropdown options — edit here to change the platforms.
export const FEISHU_JOB_PLATFORM_OPTIONS: { label: string; value: string }[] = [
  { label: "星图", value: "星图" },
  { label: "精选联盟", value: "精选联盟" },
  { label: "蒲公英", value: "蒲公英" },
];
// ⬆⬆⬆ 平台下拉选项 ⬆⬆⬆

export function createJobInputCard(params: {
  operatorOpenId: string;
  chatId?: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
}): Record<string, unknown> {
  const context = buildFeishuCardInteractionContext({
    operatorOpenId: params.operatorOpenId,
    chatId: params.chatId,
    expiresAt: params.expiresAt,
    chatType: params.chatType,
  });
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: "来活啦 🚀 新任务" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "form",
          name: "job_form",
          elements: [
            // 任务信息：标签 + 多行文本框
            { tag: "markdown", content: "**任务信息**" },
            {
              tag: "input",
              name: FEISHU_JOB_FIELD_INFO,
              // 多行文本框：可输入多行内容。
              input_type: "multiline_text",
              rows: 4,
              auto_resize: true,
              placeholder: { tag: "plain_text", content: "请输入任务信息" },
              required: true,
            },
            // 平台：标签 + 下拉（select_static 不支持原生 label，用上方文本标签替代）
            { tag: "markdown", content: "**平台**" },
            {
              tag: "select_static",
              name: FEISHU_JOB_FIELD_PLATFORM,
              placeholder: { tag: "plain_text", content: "请选择平台" },
              required: true,
              options: FEISHU_JOB_PLATFORM_OPTIONS.map((option) => ({
                text: { tag: "plain_text", content: option.label },
                value: option.value,
              })),
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "确定提交" },
              type: "primary",
              width: "default",
              // Marks this button as the form's submit trigger, so the
              // card.action.trigger callback carries action.form_value.
              form_action_type: "submit",
              name: "submit",
              // schema 2.0 delivers the callback payload via behaviors, NOT the
              // legacy top-level `value` (which is dropped on form submit).
              behaviors: [
                {
                  type: "callback",
                  value: createFeishuCardInteractionEnvelope({
                    k: "button",
                    a: FEISHU_JOB_SUBMIT_ACTION,
                    c: context,
                  }),
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export async function sendFeishuJobInputCard(params: {
  cfg: ClawdbotConfig;
  to: string;
  operatorOpenId: string;
  chatId?: string;
  chatType?: "p2p" | "group";
  accountId?: string;
  runtime?: RuntimeEnv;
  now?: number;
}): Promise<void> {
  const expiresAt = (params.now ?? Date.now()) + FEISHU_JOB_CARD_TTL_MS;
  await sendCardFeishu({
    cfg: params.cfg,
    to: params.to,
    card: createJobInputCard({
      operatorOpenId: params.operatorOpenId,
      chatId: params.chatId,
      expiresAt,
      chatType: params.chatType,
    }),
    accountId: params.accountId,
  });
}
