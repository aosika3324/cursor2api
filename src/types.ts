// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
    thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; budget_tokens?: number };
}

/** tool_choice 控制模型是否必须调用工具
 *  - auto: 模型自行决定（默认）
 *  - any:  必须调用至少一个工具
 *  - tool: 必须调用指定工具
 */
export type AnthropicToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string };

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image';
    text?: string;
    // image fields
    source?: { type: string; media_type?: string; data: string; url?: string };
    // tool_use fields
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result fields
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
}

// ==================== Cursor API Types ====================

export interface CursorChatRequest {
    context?: CursorContext[];
    model: string;
    id: string;
    messages: CursorMessage[];
    trigger: string;
}

export interface CursorContext {
    type: string;
    content: string;
    filePath: string;
}

export interface CursorMessage {
    parts: CursorPart[];
    id: string;
    role: string;
}

export interface CursorPart {
    type: string;
    text: string;
}

export interface CursorSSEEvent {
    type: string;
    delta?: string;
    finishReason?: string;
    messageMetadata?: {
        usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
        };
    };
}

// ==================== Account Pool Types ====================

/**
 * CursorAccount - 上游账号池的一个条目
 *
 * cursor2api 上游是匿名的 cursor.com 文档页 AI，无 OAuth。一个「账号」= 一份能通过
 * Vercel bot challenge 的凭据元组：cookie(_vcrcs) + 指纹(UA) + 可选的独立出口代理。
 * cookie 若共用同一出口 IP 会被 Cursor 按 IP 一起限流，故每账号可绑定各自 proxy。
 *
 * 连接字段（cookie/fingerprintUA/proxy/stealthProxyUrl）在 P1 被 cursor-client 使用；
 * 调度/统计字段（priority/disabled/cooldownUntil/...）在 P2 被调度器使用。
 */
export interface CursorAccount {
    id: string;
    name: string;
    /** Cursor 请求携带的 Cookie（通过 Vercel 安全验证的核心凭据） */
    cookie: string;
    /** 该账号专用的浏览器指纹 UA（留空则回退全局 fingerprint.userAgent） */
    fingerprintUA?: string;
    /** 该账号专用出口代理（留空则回退全局 proxy）；建议每账号独立以避免 IP 级联限流 */
    proxy?: string;
    /** 该账号走的 stealth 代理地址（留空则回退全局 stealthProxy） */
    stealthProxyUrl?: string;

    // —— 调度/状态字段（P2）——
    priority: number;          // 越小越优先，默认 0
    disabled: boolean;
    group?: string;            // 所属分组（供客户端 Key 分组隔离）
    maxConcurrency?: number;   // 单账号并发上限（留空取全局默认）

    // —— 运行时统计（持久化）——
    createdAt: string;
    lastUsedAt?: string;
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    /** 连续失败次数（成功即清零，供临时冷却判定） */
    consecutiveFailures: number;
    /** 冷却截止时间（RFC3339）；now < cooldownUntil 时不参与调度 */
    cooldownUntil?: string;
    /** 最近一次被自动禁用/冷却的原因（排障用） */
    lastErrorReason?: string;
}

/**
 * 连接所需的账号子集 —— cursor-client 只关心「怎么连上游」这几项。
 * P1 中若调用方不传 account，则由全局 config 合成一个此形状的对象，行为与改造前一致。
 */
export interface AccountConnection {
    cookie?: string;
    fingerprintUA?: string;
    proxy?: string;
    stealthProxyUrl?: string;
}

/**
 * 下游客户端 Key（P3）—— 分发给调用方的凭据（csk_ 前缀），与上游 CursorAccount 解耦。
 * 与 config.authTokens 共存：两者都能通过鉴权，但只有 client key 命中时才记用量。
 */
export interface ClientKey {
    id: string;
    /** 实际密钥串，形如 csk_xxxxxxxx */
    key: string;
    name: string;
    disabled: boolean;
    /** 分组（P4：限定该 key 只能路由到同组账号；P3 仅存储不生效） */
    group?: string;

    // —— 运行时统计（持久化）——
    createdAt: string;
    lastUsedAt?: string;
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}

/**
 * 账号分组（P4）—— 「客户端 Key ↔ 上游账号」的隔离边界。
 * 账号与 client key 以 group **名字** 引用分组，故改名需级联。
 */
export interface Group {
    id: string;
    name: string;
    createdAt: string;
}

// ==================== Internal Types ====================

export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface AppConfig {
    port: number;
    timeout: number;
    proxy?: string;
    cursorModel: string;
    authTokens?: string[];  // API 鉴权 token 列表，为空则不鉴权
    maxAutoContinue: number;        // 自动续写最大次数，默认 3，设 0 禁用
    maxHistoryMessages: number;     // 历史消息条数硬限制，默认 -1（不限制）
    maxHistoryTokens: number;       // 历史消息 token 数上限（tiktoken 估算我们发出的内容，代码自动加 Cursor 后端开销：1300 基础 + perTool*工具数），默认 150000，-1 不限制
    vision?: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        baseUrl: string;
        apiKey: string;
        model: string;
        proxy?: string;  // vision 独立代理（不影响 Cursor API 直连）
    };
    compression?: {
        enabled: boolean;          // 是否启用历史消息压缩
        level: 1 | 2 | 3;         // 压缩级别: 1=轻度, 2=中等(默认), 3=激进
        keepRecent: number;        // 保留最近 N 条消息不压缩
        earlyMsgMaxChars: number;  // 早期消息最大字符数
    };
    thinking?: {
        enabled: boolean;          // 是否启用 thinking（最高优先级，覆盖客户端请求）
    };
    logging?: {
        file_enabled: boolean;     // 是否启用日志文件持久化
        dir: string;               // 日志文件存储目录
        max_days: number;          // 日志保留天数
        persist_mode: 'compact' | 'full' | 'summary'; // 落盘模式: compact=精简, full=完整, summary=仅问答摘要
        db_enabled: boolean;       // 是否启用 SQLite 存储
        db_path: string;           // SQLite 文件路径，默认 './logs/cursor2api.db'
    };
    tools?: {
        schemaMode: 'compact' | 'full' | 'names_only';  // Schema 呈现模式
        descriptionMaxLength: number;                     // 描述截断长度 (0=不截断)
        includeOnly?: string[];                           // 白名单：只保留的工具名
        exclude?: string[];                               // 黑名单：要排除的工具名
        passthrough?: boolean;                            // 透传模式：跳过 few-shot 注入，直接嵌入工具定义
        disabled?: boolean;                               // 禁用模式：完全不注入工具定义，最大化节省上下文
        adaptiveBudget?: boolean;                         // 自适应历史预算：根据工具数量自动收紧历史 token 预算
        smartTruncation?: boolean;                        // 智能截断：按工具类型差异化截断结果（Read/Bash/Search 各用不同策略）
    };
    sanitizeEnabled: boolean;    // 是否启用响应内容清洗（替换 Cursor 身份引用为 Claude），默认 false
    contextPressure?: number;    // 上下文压力膨胀系数（默认 1.35），虚增 input_tokens 让客户端提前压缩
    refusalPatterns?: string[];  // 自定义拒绝检测规则（追加到内置列表之后）
    systemPrompt?: string;     // 自定义系统提示词，覆盖 Cursor 内置的文档助手身份
    cookie?: string;           // Cursor 请求携带的 Cookie（用于通过 Vercel 安全验证）
    stealthProxy?: string;     // Stealth 代理地址（如 http://stealth-proxy:3011），配置后通过无头浏览器转发请求
    fingerprint: {
        userAgent: string;
    };
    // —— 账号池 / 调度（P2）——
    loadBalancingMode?: 'priority' | 'balanced';  // 选号策略，默认 'priority'
    accountMaxConcurrency?: number;               // 单账号并发上限，默认 2
    accountCooldownSecs?: number;                 // 429/403 限流冷却时长(秒)，默认 1800
    accountFailureCooldownSecs?: number;          // 连续失败达阈值后的临时冷却(秒)，默认 60
    accountFailureThreshold?: number;             // 连续失败多少次触发临时冷却，默认 3
    maxAccountFailover?: number;                  // 单请求最多跨几个账号故障转移，默认 3（上限=账号数）
    adminApiKey?: string;                          // Admin API 鉴权密钥（空=禁用 Admin，P5）
}
