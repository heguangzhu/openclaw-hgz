# Feishu 性能基线

记录飞书集成关键路径的耗时分布，供未来回归比对。

## 调试事件标签

代码里 `console.error` 打的 `[DIAG-*]` 标签：

| 标签                                                        | 来源文件              | 含义                                         |
| ----------------------------------------------------------- | --------------------- | -------------------------------------------- |
| `webhook-handler-ready`                                     | `bot.ts`              | 收到 webhook、解析完 message context         |
| `prefire-start` / `prefire-done` / `prefire-failed`         | `reply-dispatcher.ts` | webhook 入口预发的 typing reaction API       |
| `dispatch-start`                                            | `bot.ts`              | dispatcher 创建完成、即将进入 reply pipeline |
| `typing-callback-start`                                     | `reply-dispatcher.ts` | pipeline 进入 typing 循环                    |
| `typing-callback-prefired`                                  | `reply-dispatcher.ts` | callback 拿到预发 promise 的结果             |
| `typing-callback-done`                                      | `reply-dispatcher.ts` | inline 模式（非 prefire）API 完成            |
| `api-pre` / `api-post`                                      | `typing.ts`           | Feishu reaction API 调用前/后                |
| `update` / `close-update` / `close-note` / `close-settings` | `streaming-card.ts`   | 卡片流式 PUT/PATCH 响应                      |

提取所有 DIAG 事件：

```
grep -oE 'DIAG-(TYPING\|RESP\|FLUSH\|CLOSE)\][^"]+' /tmp/openclaw/openclaw-YYYY-MM-DD.log
```

## 2026-04-27 基线（commit b7280d3888，Option A 上线）

5 个样本，前 2 条 inline（pre-fix），后 3 条 prefire（post-fix）。所有数值相对 `webhook-handler-ready`，单位 ms。

```
#   time       mode     wh→pf  wh→ds  wh→tcs  api-rt  wh→react  wh→1stUpd  wh→close  totalCard
1   08:25:45   inline   -      41     1248    892     2141      13065      28069     15004
2   08:26:42   inline   -      32     880     1088    1969      20469      27727     7258
3   08:52:12   prefire  31     35     1270    1966    1998      21219      26833     5614
4   08:53:29   prefire  8      10     249     854     863       13226      20862     7636
5   08:55:27   prefire  24     35     385     871     898       10704      18508     7804
```

字段说明：

- `wh→pf` — webhook → prefire-start（理想 <50ms，越小越好）
- `wh→ds` — webhook → dispatch-start（dispatcher 创建同步开销）
- `wh→tcs` — webhook → typing-callback-start（**pipeline setup 总耗时**）
- `api-rt` — Feishu reaction API 网络往返（无法本地优化）
- `wh→react` — **用户看到 typing 表情的时间**
- `wh→1stUpd` — webhook → 第一个卡片内容 PUT 成功 = LLM 首字延迟
- `wh→close` — webhook → close-settings 完成 = 整条回复结束
- `totalCard` — 1stUpd → close（卡片流式生成 + 5 次串行 PUT/PATCH）

## 关键基线数字（典型值，剔除离群）

| 指标                            | 值              | 备注                      |
| ------------------------------- | --------------- | ------------------------- |
| webhook → prefire 起飞          | 8–31 ms         | 接近 0                    |
| dispatcher 创建                 | 10–41 ms        | 同步开销很小              |
| pipeline setup (wh→tcs)         | **249–1270 ms** | 方差极大，冷热相关        |
| Feishu reaction API 往返        | 854–1088 ms     | 网络主导，偶有 ~2s 慢请求 |
| typing 表情可见 (post-Option-A) | **~880 ms**     | 比 inline ~2055ms 砍 ~57% |
| LLM 首字 (wh→1stUpd)            | 10–21 s         | 占整体 ~70%，**主导项**   |
| 整条回复 (wh→close)             | 18–28 s         | LLM 长度决定              |
| 卡片流式生成 (totalCard)        | 5.6–15 s        | 与回复字数线性相关        |

## 观察

1. **typing 表情那 1 秒占总回复时间 3-5%**——继续优化 typing 边际收益低
2. **LLM 推理才是大头**——任何砍秒的努力应聚焦 LLM 首字延迟（agent 选型、context 长度、warm pool）
3. **pipeline setup 方差大**——249ms vs 1270ms。如果要再优化飞书侧，方向是减少 dispatcher 同步初始化（resolveAccount、createReplyPipeline 等）
4. **Feishu API 抖动是已知**——会出现 ~2s 慢请求（样本 3），无法预测
5. **5 次 PUT/PATCH 串行收尾**——`close()` 必须串行（card-wide 序列号，commit 95c09a0cbb），是 ~3s 不可避免成本

## 未做但记录的方案

- **Option B：fire-and-forget typing API** — 不 await Feishu 响应。分析认为对整体回复时间几乎无收益（typing.start 的 await 与 LLM 推理并行，本来就不卡主路径），仅在 API 异常拖慢时有防御价值。未实施。
