import { clearModelOverride, getModelStatus, writeModelConfig } from '../../model-config.js';
import type { CommandResult } from '../types.js';

export async function handleModelCommand(args: string[]): Promise<CommandResult> {
  const raw = args.join(' ').trim();
  const lowered = raw.toLowerCase();
  if (!raw || lowered === 'status') {
    return await renderModelStatus();
  }

  if (lowered === 'reset' || lowered === 'default') {
    try {
      const result = await clearModelOverride();
      return {
        type: 'handled',
        message: `✅ 已恢复默认模型\nConfig: ${result.path}`,
      };
    } catch (error) {
      console.error('[model-config] failed to reset model config:', error);
      return {
        type: 'handled',
        message: '❌ 恢复默认模型失败，请检查服务日志。',
      };
    }
  }

  const model = raw;
  try {
    const result = await writeModelConfig({ current_model: model });
    return {
      type: 'handled',
      message: `✅ 已更新模型为 ${model}\nConfig: ${result.path}`,
    };
  } catch (error) {
    console.error('[model-config] failed to update model config:', error);
    return {
      type: 'handled',
      message: '❌ 更新模型失败，请检查服务日志。',
    };
  }
}

async function renderModelStatus(): Promise<CommandResult> {
  try {
    const status = await getModelStatus();
    if (!status.path) {
      return {
        type: 'handled',
        message: 'ℹ️ 当前未找到模型配置文件。',
      };
    }

    const lines = ['🧠 当前模型信息：', `- Config: ${status.path}`];
    if (status.currentModel) {
      lines.push(`- current_model: ${status.currentModel}`);
    } else {
      lines.push('- current_model: (未设置)');
    }
    if (status.resolvedModel) {
      lines.push(`- resolved_model: ${status.resolvedModel}`);
    } else {
      lines.push('- resolved_model: (未解析到)');
    }
    if (status.models && status.models.length > 0) {
      lines.push(`- models: ${status.models.join(', ')}`);
    }
    return {
      type: 'handled',
      message: lines.join('\n'),
    };
  } catch (error) {
    console.error('[model-config] failed to read model status:', error);
    return {
      type: 'handled',
      message: '❌ 查询模型状态失败，请检查服务日志。',
    };
  }
}
