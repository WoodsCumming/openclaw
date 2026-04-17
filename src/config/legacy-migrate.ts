import { applyLegacyMigrations } from "./legacy.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

/**
 * 对原始配置对象执行旧版（legacy）格式迁移，并返回迁移后经过验证的配置。
 *
 * **迁移的内容**（由 `LEGACY_CONFIG_MIGRATIONS` 规则集驱动）：
 * - 旧版 API key 字段名（如 `openai_api_key` → `models.openai.apiKey`）。
 * - 旧版频道配置路径格式（如顶层 `telegram` / `discord` 字段 → `channels.telegram` / `channels.discord`）。
 * - 旧版 agent 定义格式（数组项结构变更）。
 * - 其他历史遗留字段的重命名/移除。
 *
 * **执行流程**：
 * 1. 调用 `applyLegacyMigrations(raw)` 对原始对象进行深克隆并逐条应用迁移规则，
 *    收集变更描述到 `changes` 数组。
 * 2. 若无任何变更（`changes.length === 0`），直接返回 `{ config: null, changes: [] }`，
 *    表示配置已为最新格式，无需迁移。
 * 3. 对迁移后的结果执行 Schema 验证（`validateConfigObjectWithPlugins`）；
 *    若验证失败则在 `changes` 中追加错误提示，并返回 `config: null`。
 * 4. 验证通过则返回完整的 `OpenClawConfig` 对象及变更列表。
 *
 * @param raw - 从配置文件读取的原始 unknown 对象（未经验证的 JSON5 解析结果）。
 * @returns 包含迁移后配置（若迁移成功）和变更描述列表的对象。
 *          `config` 为 `null` 表示无需迁移或迁移后仍然无效。
 */
export function migrateLegacyConfig(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  const { next, changes } = applyLegacyMigrations(raw);
  if (!next) {
    return { config: null, changes: [] };
  }
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    changes.push("Migration applied, but config still invalid; fix remaining issues manually.");
    return { config: null, changes };
  }
  return { config: validated.config, changes };
}
