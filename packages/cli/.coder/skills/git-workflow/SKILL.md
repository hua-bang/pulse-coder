---
name: git-workflow
description: Standard git workflow for handling staged changes on existing branch - add, commit, and push
description_zh: 在现有分支上处理已暂存代码的标准 git 工作流程 - 添加、提交和推送
version: 1.2.0
author: Coder Team
---

# Git Workflow Skill

这个 skill 提供了一个简化的 git 工作流程，专注于在当前分支上处理更改，不创建新分支。

## 工作流程步骤

### 1. 检查当前状态
```bash
git status
```
检查当前分支状态，识别：
- 已修改的文件 (modified files)
- 未跟踪的文件 (untracked files)
- 已暂存的文件 (staged files)

### 2. 添加更改到暂存区
```bash
git add <files...>
```
根据情况选择：
- `git add .` - 添加所有更改
- `git add -A` - 添加所有文件（包括删除的）
- `git add <specific-files>` - 只添加特定文件

### 3. 提交更改
```bash
git commit -m "<type>: <short description>"
```

提交消息格式：
```
<type>: <short description>

- <详细描述点1>
- <详细描述点2>
```

类型包括：
- `feat` - 新功能
- `fix` - 修复
- `refactor` - 重构
- `docs` - 文档
- `style` - 格式调整
- `test` - 测试
- `chore` - 构建/工具

### 4. 推送到远程仓库
```bash
git push
```

## 快速工作流程

```bash
# 一键完成
git status
git add .
git commit -m "描述更改内容"
git push
```

## 选择性工作流程

### 只添加特定文件
```bash
git add src/ docs/
git commit -m "feat: 更新核心功能和文档"
git push
```

### 分批次提交
```bash
git add src/app.ts
git commit -m "feat: 添加新功能"
git add tests/
git commit -m "test: 添加对应测试"
git push
```

## 验证步骤

完成每个步骤后验证：
1. `git status` - 确认工作目录干净
2. `git log --oneline -3` - 查看最新提交
3. `git branch` - 确认当前分支