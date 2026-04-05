# 文档五：自动使用最新附件（图片）设计

## 1. 目标

- 支持用户在平台发送图片（附件），自动保存到本地并记录到会话。
- 识图工具默认使用“最新一条消息里的所有图片”，无需用户显式传入路径。
- 附件信息写入 `runContext` 和 system prompt，方便 LLM 感知与调用。

## 2. 数据流（高层）

```
平台事件（含附件）
  └─ adapter.parseIncoming() 解析附件元信息
      └─ dispatcher.runAgentAsync()
          ├─ 下载附件到 vault.artifacts
          ├─ sessionStore.latestAttachments 更新
          ├─ runContext 注入 latestAttachments
          └─ systemPrompt 追加附件摘要
              └─ LLM 调用 analyze_image（默认使用最新附件）
```

## 3. 核心规则

- **默认规则**：自动使用“最新一条消息里的所有图片”。
- 当用户没有继续上传图片时，依旧复用该最新附件列表。
- 若当前消息仅包含附件、无文本，也要触发会话更新，并提供一个占位文本用于进入 agent loop。

## 4. 结构定义

### 4.1 IncomingAttachment（平台输入）

```ts
interface IncomingAttachment {
  id?: string;
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
  source?: string;      // discord | feishu | web ...
  messageId?: string;
}
```

### 4.2 StoredAttachment（会话落盘）

```ts
interface StoredAttachment {
  id: string;
  path: string;         // 本地绝对路径
  mimeType?: string;
  name?: string;
  size?: number;
  source?: string;
  messageId?: string;
  createdAt: number;
  originalUrl?: string;
}
```

### 4.3 Session Storage

- `RemoteSession.latestAttachments?: StoredAttachment[]`
- 新附件到达即覆盖旧值（保持“最新一条消息”语义）
- `/clear` 或新会话时清空

## 5. 运行时注入

### 5.1 runContext

```ts
runContext.latestAttachments = StoredAttachment[]
```

### 5.2 system prompt 附加信息（示例）

```
Latest attachments available:
- [1] id=... name=... mime=image/png size=...
- [2] id=... name=... mime=image/jpeg size=...
Use tool analyze_image without imagePaths to analyze the latest attachments by default.
```

## 6. 工具行为（analyze_image）

- 入参 `imagePaths` 可选。
- 未提供 `imagePaths` 时，自动使用 `runContext.latestAttachments` 的本地路径。
- 默认 prompt：`请描述图片并回答用户问题`（或由用户 input.prompt 覆盖）
- 依赖 `GEMINI_API_KEY`（可配置为其它 Vision Provider）

## 7. 安全与约束

- 仅接受 `image/*` MIME 或常见图片扩展名
- 限制单张图片大小（默认 10MB）
- 下载失败时：清空 latestAttachments 并提示用户重试

## 8. 迭代空间

- TTL 过期策略（防止过旧图片误用）
- 多平台附件解析扩展（Feishu/Web）
- 按 messageId/turnId 追溯附件历史
