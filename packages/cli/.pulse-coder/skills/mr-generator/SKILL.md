---
name: mr-generator
description: Automatically generate concise MR titles and descriptions based on current branch diff
description_zh: 基于当前分支与远程 master 的 diff 自动生成简洁英文 MR 标题和描述的 skill。
version: 1.0.0
author: Pulse Coder Team
---
# MR Generator Skill

基于当前分支与远程 master 的 diff 自动生成简洁英文 MR 标题和描述的 skill。

## 核心功能

### 1. 智能 diff 分析
- 分析文件变更类型和范围
- 识别主要功能模块
- 提取关键变更点

### 2. 自动标题生成
- 基于变更类型选择合适的动词
- 包含主要功能模块
- 保持在 50 字符以内

### 3. 简洁描述生成
- 列出核心变更点
- 使用项目符号格式
- 英文简洁表达

## 使用方式

### 基本使用
```bash
# 生成 MR 标题和描述
./mr-generate.sh

# 指定目标分支（默认 origin/master）
./mr-generate.sh --target origin/develop

# 预览模式
./mr-generate.sh --preview
```

### 集成到工作流
```bash
# 在创建 MR 前运行
git push origin HEAD
./mr-generate.sh | gh pr create --title "$(head -1)" --body "$(tail -n +3)"
```

## 标题生成规则

### 变更类型映射
- **新功能**: Add / Implement / Introduce
- **修复**: Fix / Resolve / Correct
- **重构**: Refactor / Improve / Optimize
- **文档**: Update / Add docs
- **测试**: Add tests / Improve coverage
- **配置**: Update config / Setup

### 模块提取
- 基于文件路径识别主要模块
- 优先使用业务功能名称
- 简洁技术术语

## 描述格式

```
Brief description of changes

- Key change 1
- Key change 2
- Impact or improvement
```

## 示例输出

### 功能开发
**标题**: `Add user authentication with JWT`

**描述**:
```
Implement secure user authentication using JWT tokens

- Add login/logout endpoints
- Implement token validation middleware
- Add user registration flow
- Update API documentation
```

### Bug 修复
**标题**: `Fix login validation error`

**描述**:
```
Resolve email validation issue in user login

- Fix regex pattern for email validation
- Add proper error handling for invalid formats
- Update unit tests for edge cases
```

### 重构
**标题**: `Refactor API response handling`

**描述**:
```
Improve API response consistency and error handling

- Standardize response format across endpoints
- Add centralized error handling middleware
- Reduce code duplication in controllers
- Update test assertions
```