---
name: branch-naming
description: Intelligent branch naming based on changes, context, and best practices
description_zh: 基于更改内容、上下文和最佳实践的智能分支命名
version: 1.1.0
author: Pulse Coder Team
---

# Branch Naming Skill (增强版)

这个 skill 专门用于生成合适的 git 分支名称，提供多种生成策略和实用工具。

## 快速使用

### 一键生成分支名
```bash
# 基本使用
./branch-name-suggest.sh

# 指定类型
./branch-name-suggest.sh --type feature

# 指定描述
./branch-name-suggest.sh --desc "用户认证"

# 检查当前分支
./branch-name-suggest.sh --check
```

## 高级功能

### 1. 上下文感知命名
```bash
#!/bin/bash
# context-aware-naming.sh

get_branch_context() {
    local context=""
    
    # 检查是否在 issue 分支上
    if git branch --show-current | grep -q "issue-"; then
        issue_num=$(git branch --show-current | grep -o "issue-[0-9]*")
        context="$issue_num"
    fi
    
    # 检查是否有 Jira ticket
    if git log --oneline -1 | grep -q "[A-Z]*-[0-9]*"; then
        ticket=$(git log --oneline -1 | grep -o "[A-Z]*-[0-9]*")
        context="$ticket"
    fi
    
    echo "$context"
}

# 基于上下文生成
generate_contextual_name() {
    local type=$1
    local description=$2
    local context=$(get_branch_context)
    
    if [[ -n "$context" ]]; then
        echo "${type}/${context}-${description}"
    else
        echo "${type}/${description}"
    fi
}
```

### 2. 语义化描述生成
```bash
#!/bin/bash
# semantic-description.sh

generate_semantic_desc() {
    local files=$(git diff --name-only)
    local desc=""
    
    # 分析主要功能
    if echo "$files" | grep -q "auth\|login\|sign"; then
        desc="auth"
    elif echo "$files" | grep -q "api\|service\|endpoint"; then
        desc="api"
    elif echo "$files" | grep -q "ui\|component\|page"; then
        desc="ui"
    elif echo "$files" | grep -q "config\|setting"; then
        desc="config"
    else
        # 基于最核心文件
        main_file=$(echo "$files" | head -1 | sed 's/.*\///' | sed 's/\..*$//')
        desc=$(echo "$main_file" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')
    fi
    
    echo "$desc"
}
```

### 3. 团队约定集成
```bash
#!/bin/bash
# team-naming-rules.sh

# 加载团队规则
load_team_rules() {
    local config_file=".branch-naming-rules"
    
    if [[ -f "$config_file" ]]; then
        source "$config_file"
    else
        # 默认规则
        export PREFIXES=("feature" "fix" "refactor" "hotfix" "docs" "test" "chore")
        export MAX_LENGTH=50
        export SEPARATOR="-"
        export CASE="lowercase"
    fi
}

# 验证分支名是否符合团队约定
validate_team_naming() {
    local branch_name=$1
    load_team_rules
    
    # 检查前缀
    local valid_prefix=false
    for prefix in "${PREFIXES[@]}"; do
        if [[ "$branch_name" == "$prefix"/* ]]; then
            valid_prefix=true
            break
        fi
    done
    
    if [[ "$valid_prefix" == false ]]; then
        echo "❌ 无效前缀。有效前缀: ${PREFIXES[*]}"
        return 1
    fi
    
    # 检查长度
    if [[ ${#branch_name} -gt $MAX_LENGTH ]]; then
        echo "❌ 分支名过长 (最大 $MAX_LENGTH 字符)"
        return 1
    fi
    
    echo "✅ 符合团队约定"
    return 0
}
```

## 实际场景示例

### 场景1：功能开发
```bash
# 更改文件
src/components/UserProfile.tsx
src/hooks/useUser.ts
src/services/userService.ts

# 生成分支名
feature/user-profile-enhancement
```

### 场景2：Bug修复
```bash
# 更改文件
src/utils/validation.js
src/pages/Login.js

# 生成分支名
fix/login-validation-error
```

### 场景3：集成Jira
```bash
# 基于Jira ticket
PROJ-123: Add user authentication

# 生成分支名
feature/PROJ-123-user-authentication
```

### 场景4：紧急修复
```bash
# 紧急生产问题
src/security/auth.js

# 生成分支名
hotfix/security-vulnerability-fix
```

## 完整脚本工具

### 主脚本：branch-name-generator.sh
```bash
#!/bin/bash
# 完整的分支名称生成器

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 帮助信息
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -t, --type TYPE     指定分支类型 (feature/fix/refactor/docs/test/chore/hotfix)"
    echo "  -d, --desc DESC     指定描述"
    echo "  -c, --check         检查当前分支名"
    echo "  -i, --interactive   交互模式"
    echo "  -h, --help          显示帮助"
    echo ""
    echo "Examples:"
    echo "  $0                  # 自动分析并建议"
    echo "  $0 -t feature -d 'user auth'"
    echo "  $0 --check"
    echo "  $0 --interactive"
}

# 检查当前分支
check_current_branch() {
    local current=$(git branch --show-current)
    echo -e "${BLUE}当前分支: ${NC}$current"
    
    if [[ "$current" =~ ^(master|main|dev|develop)$ ]]; then
        echo -e "${YELLOW}⚠️  当前分支为基础分支，建议创建新分支${NC}"
        return 0
    else
        echo -e "${GREEN}✅ 当前分支: $current${NC}"
        return 1
    fi
}

# 分析更改类型
analyze_changes() {
    local files=$(git diff --name-only 2>/dev/null || echo "")
    local untracked=$(git ls-files --others --exclude-standard 2>/dev/null || echo "")
    local all_changes="$files\n$untracked"
    
    if [[ -z "$all_changes" ]]; then
        echo "no-changes"
        return
    fi
    
    # 文件类型权重
    local weights=(
        "feature:$(echo "$all_changes" | grep -c 'src/\|lib/\|components/\|pages/' || echo 0)"
        "fix:$(echo "$all_changes" | grep -c 'fix\|bug\|patch' || echo 0)"
        "test:$(echo "$all_changes" | grep -c 'test\|spec\|__tests__' || echo 0)"
        "docs:$(echo "$all_changes" | grep -c '\.md\|docs/\|README' || echo 0)"
        "chore:$(echo "$all_changes" | grep -c 'package\.json\|\.config\|\.yml' || echo 0)"
    )
    
    # 找出权重最高的类型
    local max_weight=0
    local best_type="feature"
    
    for weight in "${weights[@]}"; do
        local type=$(echo "$weight" | cut -d: -f1)
        local value=$(echo "$weight" | cut -d: -f2)
        if [[ $value -gt $max_weight ]]; then
            max_weight=$value
            best_type=$type
        fi
    done
    
    echo "$best_type"
}

# 生成描述
generate_description() {
    local changes=$(git diff --name-only 2>/dev/null || git ls-files --others --exclude-standard 2>/dev/null || echo "")
    
    if [[ -z "$changes" ]]; then
        echo "updates"
        return
    fi
    
    # 提取主要文件名
    local main_file=$(echo "$changes" | head -1 | sed 's/.*\///' | sed 's/\..*$//')
    if [[ -z "$main_file" ]]; then
        main_file="changes"
    fi
    
    # 清理特殊字符
    local clean_desc=$(echo "$main_file" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//g; s/-$//g')
    echo "$clean_desc"
}

# 生成完整分支名
generate_branch_name() {
    local type=${1:-$(analyze_changes)}
    local desc=${2:-$(generate_description)}
    
    # 检查是否有 Jira ticket
    local jira_ticket=$(git log --oneline -1 2>/dev/null | grep -o "[A-Z]*-[0-9]*" || echo "")
    
    local branch_name
    if [[ -n "$jira_ticket" ]]; then
        branch_name="${type}/${jira_ticket}-${desc}"
    else
        branch_name="${type}/${desc}"
    fi
    
    # 确保不超过50字符
    if [[ ${#branch_name} -gt 50 ]]; then
        branch_name="${branch_name:0:50}"
    fi
    
    echo "$branch_name"
}

# 交互模式
interactive_mode() {
    echo -e "${BLUE}=== 交互式分支命名 ===${NC}"
    
    check_current_branch
    
    local suggested_type=$(analyze_changes)
    local suggested_desc=$(generate_description)
    
    echo ""
    echo -e "${GREEN}分析结果:${NC}"
    echo "建议类型: $suggested_type"
    echo "建议描述: $suggested_desc"
    
    echo ""
    echo "1) 使用建议: ${suggested_type}/${suggested_desc}"
    echo "2) 自定义类型和描述"
    echo "3) 查看其他建议"
    read -p "选择 [1-3]: " choice
    
    case $choice in
        1)
            echo $(generate_branch_name "$suggested_type" "$suggested_desc")
            ;;
        2)
            read -p "分支类型 (feature/fix/refactor/docs/test/chore/hotfix): " custom_type
            read -p "分支描述: " custom_desc
            echo $(generate_branch_name "$custom_type" "$custom_desc")
            ;;
        3)
            echo "更多建议:"
            echo "- ${suggested_type}/${suggested_desc}-$(date +%m%d)"
            echo "- ${suggested_type}/$(date +%Y%m%d)-${suggested_desc}"
            ;;
    esac
}

# 主程序
main() {
    local type=""
    local desc=""
    local check_only=false
    local interactive=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            -t|--type)
                type="$2"
                shift 2
                ;;
            -d|--desc)
                desc="$2"
                shift 2
                ;;
            -c|--check)
                check_only=true
                shift
                ;;
            -i|--interactive)
                interactive=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                echo "未知选项: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    if [[ "$check_only" == true ]]; then
        check_current_branch
        exit 0
    fi
    
    if [[ "$interactive" == true ]]; then
        interactive_mode
        exit 0
    fi
    
    # 默认行为
    local branch_name=$(generate_branch_name "$type" "$desc")
    echo "$branch_name"
}

# 如果直接运行
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

## 集成到工作流

### 添加到 package.json
```json
{
  "scripts": {
    "branch:suggest": "./.coder/skills/branch-naming/branch-name-generator.sh",
    "branch:check": "./.coder/skills/branch-naming/branch-name-generator.sh --check",
    "branch:interactive": "./.coder/skills/branch-naming/branch-name-generator.sh --interactive"
  }
}
```

### Git 别名配置
```bash
git config alias.suggest "!.coder/skills/branch-naming/branch-name-generator.sh"
git config alias.branch-check "!.coder/skills/branch-naming/branch-name-generator.sh --check"
```